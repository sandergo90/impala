use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

use crate::git;

/// A file has been marked as viewed at a specific blob content. The row's
/// presence means "this exact content was reviewed"; the row's absence for
/// the current content means "not reviewed."
///
/// `content_sha` is either a git blob sha (worktree hash-object for the
/// uncommitted view, or the tree-blob sha at HEAD / the selected commit) or
/// the sentinel `"deleted"` when the file has no right-hand side in the
/// current view.
pub const DELETED_SENTINEL: &str = "deleted";

pub fn init_db(conn: &Connection) -> Result<(), String> {
    // The previous schema keyed by (commit_hash, patch_hash) was fragile: the
    // patch hash shifts whenever the merge-base moves or staging changes, so
    // viewed rows got silently evicted. Drop it and start over keyed by the
    // right-hand blob sha of the file itself.
    conn.execute_batch(
        "DROP TABLE IF EXISTS viewed_files;
         CREATE TABLE viewed_files (
            worktree_path    TEXT NOT NULL,
            file_path        TEXT NOT NULL,
            content_sha      TEXT NOT NULL,
            viewed_at_commit TEXT,
            created_at       TEXT NOT NULL,
            PRIMARY KEY (worktree_path, file_path, content_sha)
         );",
    )
    .map_err(|e| format!("Failed to initialize viewed_files table: {}", e))
}

#[derive(Debug, Clone, Copy)]
pub enum ViewKind<'a> {
    Uncommitted,
    AllChanges,
    Commit(&'a str),
}

impl<'a> ViewKind<'a> {
    pub fn from_parts(kind: &'a str, commit_hash: Option<&'a str>) -> Result<Self, String> {
        match kind {
            "uncommitted" => Ok(ViewKind::Uncommitted),
            "all-changes" => Ok(ViewKind::AllChanges),
            "commit" => commit_hash
                .map(ViewKind::Commit)
                .ok_or_else(|| "commit view requires commit_hash".to_string()),
            other => Err(format!("unknown view kind: {}", other)),
        }
    }
}

fn content_sha_for_file(worktree_path: &str, view: ViewKind, file_path: &str) -> String {
    match view {
        ViewKind::Uncommitted => git::hash_worktree_file(worktree_path, file_path)
            .unwrap_or_else(|_| DELETED_SENTINEL.to_string()),
        ViewKind::AllChanges => git::blob_sha_at_ref(worktree_path, "HEAD", file_path)
            .unwrap_or_else(|_| DELETED_SENTINEL.to_string()),
        ViewKind::Commit(sha) => git::blob_sha_at_ref(worktree_path, sha, file_path)
            .unwrap_or_else(|_| DELETED_SENTINEL.to_string()),
    }
}

fn content_shas_for_files(
    worktree_path: &str,
    view: ViewKind,
    file_paths: &[String],
) -> HashMap<String, String> {
    match view {
        ViewKind::Uncommitted => file_paths
            .iter()
            .map(|p| {
                let sha = git::hash_worktree_file(worktree_path, p)
                    .unwrap_or_else(|_| DELETED_SENTINEL.to_string());
                (p.clone(), sha)
            })
            .collect(),
        ViewKind::AllChanges => batch_blob_shas(worktree_path, "HEAD", file_paths),
        ViewKind::Commit(sha) => batch_blob_shas(worktree_path, sha, file_paths),
    }
}

fn batch_blob_shas(
    worktree_path: &str,
    git_ref: &str,
    file_paths: &[String],
) -> HashMap<String, String> {
    let tree = git::ls_tree_blobs(worktree_path, git_ref).unwrap_or_default();
    file_paths
        .iter()
        .map(|p| {
            let sha = tree
                .get(p)
                .cloned()
                .unwrap_or_else(|| DELETED_SENTINEL.to_string());
            (p.clone(), sha)
        })
        .collect()
}

pub fn set_viewed(
    conn: &Connection,
    worktree_path: &str,
    view: ViewKind,
    file_path: &str,
) -> Result<(), String> {
    let content_sha = content_sha_for_file(worktree_path, view, file_path);
    let viewed_at_commit = git::get_head_commit(worktree_path).ok();
    let now = chrono::Utc::now().to_rfc3339();
    insert_one(conn, worktree_path, file_path, &content_sha, viewed_at_commit.as_deref(), &now)
}

pub fn set_many_viewed(
    conn: &mut Connection,
    worktree_path: &str,
    view: ViewKind,
    file_paths: &[String],
) -> Result<(), String> {
    if file_paths.is_empty() {
        return Ok(());
    }
    let shas = content_shas_for_files(worktree_path, view, file_paths);
    let viewed_at_commit = git::get_head_commit(worktree_path).ok();
    let now = chrono::Utc::now().to_rfc3339();

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;
    for path in file_paths {
        let sha = shas
            .get(path)
            .cloned()
            .unwrap_or_else(|| DELETED_SENTINEL.to_string());
        insert_one(&tx, worktree_path, path, &sha, viewed_at_commit.as_deref(), &now)?;
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;
    Ok(())
}

fn insert_one(
    conn: &Connection,
    worktree_path: &str,
    file_path: &str,
    content_sha: &str,
    viewed_at_commit: Option<&str>,
    created_at: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO viewed_files
            (worktree_path, file_path, content_sha, viewed_at_commit, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(worktree_path, file_path, content_sha)
         DO UPDATE SET viewed_at_commit = excluded.viewed_at_commit,
                       created_at       = excluded.created_at",
        params![worktree_path, file_path, content_sha, viewed_at_commit, created_at],
    )
    .map_err(|e| format!("Failed to set file as viewed: {}", e))?;
    Ok(())
}

/// Un-view wipes every stored version for this file — clicking "un-view"
/// means "I have not reviewed any version of this file," not just "forget
/// the one currently on disk."
pub fn unset_viewed(
    conn: &Connection,
    worktree_path: &str,
    file_path: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM viewed_files WHERE worktree_path = ?1 AND file_path = ?2",
        params![worktree_path, file_path],
    )
    .map_err(|e| format!("Failed to unset file as viewed: {}", e))?;
    Ok(())
}

pub fn unset_many_viewed(
    conn: &mut Connection,
    worktree_path: &str,
    file_paths: &[String],
) -> Result<(), String> {
    if file_paths.is_empty() {
        return Ok(());
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;
    for path in file_paths {
        tx.execute(
            "DELETE FROM viewed_files WHERE worktree_path = ?1 AND file_path = ?2",
            params![worktree_path, path],
        )
        .map_err(|e| format!("Failed to unset file as viewed: {}", e))?;
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;
    Ok(())
}

/// Given the current view and a list of file paths, return the subset that
/// are marked viewed (their current content sha is in the stored set).
pub fn check_viewed(
    conn: &Connection,
    worktree_path: &str,
    view: ViewKind,
    file_paths: &[String],
) -> Result<Vec<String>, String> {
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }

    let stored: HashSet<(String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT file_path, content_sha FROM viewed_files WHERE worktree_path = ?1",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let rows = stmt
            .query_map(params![worktree_path], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Failed to query viewed files: {}", e))?;
        let mut set = HashSet::new();
        for row in rows {
            set.insert(row.map_err(|e| format!("Failed to read viewed row: {}", e))?);
        }
        set
    };

    let current = content_shas_for_files(worktree_path, view, file_paths);
    let viewed = file_paths
        .iter()
        .filter(|p| {
            current
                .get(*p)
                .map(|sha| stored.contains(&((*p).clone(), sha.clone())))
                .unwrap_or(false)
        })
        .cloned()
        .collect();

    Ok(viewed)
}

pub fn clear_for_worktree(conn: &Connection, worktree_path: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM viewed_files WHERE worktree_path = ?1",
        params![worktree_path],
    )
    .map_err(|e| format!("Failed to clear viewed files: {}", e))?;
    Ok(())
}
