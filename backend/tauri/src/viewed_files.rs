use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ViewedFile {
    pub worktree_path: String,
    pub commit_hash: String,
    pub file_path: String,
    pub patch_hash: String,
    pub created_at: String,
}

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS viewed_files (
            worktree_path TEXT NOT NULL,
            commit_hash   TEXT NOT NULL,
            file_path     TEXT NOT NULL,
            patch_hash    TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            PRIMARY KEY (worktree_path, commit_hash, file_path)
        );",
    )
    .map_err(|e| format!("Failed to initialize viewed_files table: {}", e))
}

pub fn set_viewed(
    conn: &Connection,
    worktree_path: &str,
    commit_hash: &str,
    file_path: &str,
    patch_hash: &str,
) -> Result<ViewedFile, String> {
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO viewed_files (worktree_path, commit_hash, file_path, patch_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(worktree_path, commit_hash, file_path)
         DO UPDATE SET patch_hash = excluded.patch_hash, created_at = excluded.created_at",
        params![worktree_path, commit_hash, file_path, patch_hash, now],
    )
    .map_err(|e| format!("Failed to set file as viewed: {}", e))?;

    Ok(ViewedFile {
        worktree_path: worktree_path.to_string(),
        commit_hash: commit_hash.to_string(),
        file_path: file_path.to_string(),
        patch_hash: patch_hash.to_string(),
        created_at: now,
    })
}

pub fn unset_viewed(
    conn: &Connection,
    worktree_path: &str,
    commit_hash: &str,
    file_path: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM viewed_files WHERE worktree_path = ?1 AND commit_hash = ?2 AND file_path = ?3",
        params![worktree_path, commit_hash, file_path],
    )
    .map_err(|e| format!("Failed to unset file as viewed: {}", e))?;

    Ok(())
}

pub fn list_viewed(
    conn: &Connection,
    worktree_path: &str,
    commit_hash: &str,
) -> Result<Vec<ViewedFile>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT worktree_path, commit_hash, file_path, patch_hash, created_at
             FROM viewed_files
             WHERE worktree_path = ?1 AND commit_hash = ?2",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map(params![worktree_path, commit_hash], |row| {
            Ok(ViewedFile {
                worktree_path: row.get(0)?,
                commit_hash: row.get(1)?,
                file_path: row.get(2)?,
                patch_hash: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query viewed files: {}", e))?;

    let mut viewed = Vec::new();
    for row in rows {
        viewed.push(row.map_err(|e| format!("Failed to read viewed file: {}", e))?);
    }

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
