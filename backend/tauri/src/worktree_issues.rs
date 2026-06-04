use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeIssue {
    pub worktree_path: String,
    pub issue_id: String,
    pub identifier: String,
    /// Which Issue tracker the linked Issue belongs to ("linear" | "jira").
    pub provider: String,
    /// Canonical issue URL, captured at link time so the sidebar link is
    /// provider-neutral (no hardcoded host, no per-project lookup at render).
    pub url: String,
    pub created_at: String,
}

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS worktree_issues (
            worktree_path TEXT PRIMARY KEY,
            issue_id TEXT NOT NULL,
            identifier TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'linear',
            url TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to initialize worktree_issues table: {}", e))?;
    migrate_add_provider_url(conn)
}

/// Existing installs have the pre-multi-tracker table without `provider`/`url`.
/// Add them and backfill rows as Linear — the URL the sidebar used to hardcode
/// from the identifier. Runs once: the backfill is scoped to column creation.
fn migrate_add_provider_url(conn: &Connection) -> Result<(), String> {
    let cols = existing_columns(conn)?;
    if !cols.contains("provider") {
        conn.execute(
            "ALTER TABLE worktree_issues ADD COLUMN provider TEXT NOT NULL DEFAULT 'linear'",
            [],
        )
        .map_err(|e| format!("Failed to add provider column: {}", e))?;
    }
    if !cols.contains("url") {
        conn.execute(
            "ALTER TABLE worktree_issues ADD COLUMN url TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| format!("Failed to add url column: {}", e))?;
        conn.execute(
            "UPDATE worktree_issues SET url = 'https://linear.app/issue/' || identifier \
             WHERE url = ''",
            [],
        )
        .map_err(|e| format!("Failed to backfill issue urls: {}", e))?;
    }
    Ok(())
}

fn existing_columns(conn: &Connection) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(worktree_issues)")
        .map_err(|e| format!("Failed to read table info: {}", e))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to query table info: {}", e))?;
    let mut set = HashSet::new();
    for row in rows {
        set.insert(row.map_err(|e| format!("Failed to read column name: {}", e))?);
    }
    Ok(set)
}

pub fn link_worktree(
    conn: &Connection,
    worktree_path: &str,
    issue_id: &str,
    identifier: &str,
    provider: &str,
    url: &str,
) -> Result<WorktreeIssue, String> {
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO worktree_issues (worktree_path, issue_id, identifier, provider, url, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(worktree_path)
         DO UPDATE SET issue_id = excluded.issue_id, identifier = excluded.identifier,
                       provider = excluded.provider, url = excluded.url,
                       created_at = excluded.created_at",
        params![worktree_path, issue_id, identifier, provider, url, now],
    )
    .map_err(|e| format!("Failed to link worktree to issue: {}", e))?;

    Ok(WorktreeIssue {
        worktree_path: worktree_path.to_string(),
        issue_id: issue_id.to_string(),
        identifier: identifier.to_string(),
        provider: provider.to_string(),
        url: url.to_string(),
        created_at: now,
    })
}

fn row_to_issue(row: &rusqlite::Row) -> rusqlite::Result<WorktreeIssue> {
    Ok(WorktreeIssue {
        worktree_path: row.get(0)?,
        issue_id: row.get(1)?,
        identifier: row.get(2)?,
        provider: row.get(3)?,
        url: row.get(4)?,
        created_at: row.get(5)?,
    })
}

const SELECT_COLS: &str =
    "worktree_path, issue_id, identifier, provider, url, created_at";

pub fn get_issue_for_worktree(
    conn: &Connection,
    worktree_path: &str,
) -> Result<Option<WorktreeIssue>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM worktree_issues WHERE worktree_path = ?1",
            SELECT_COLS
        ))
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let mut rows = stmt
        .query_map(params![worktree_path], row_to_issue)
        .map_err(|e| format!("Failed to query worktree issue: {}", e))?;

    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| format!("Failed to read row: {}", e))?)),
        None => Ok(None),
    }
}

pub fn get_all_worktree_issues(conn: &Connection) -> Result<Vec<WorktreeIssue>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM worktree_issues", SELECT_COLS))
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map([], row_to_issue)
        .map_err(|e| format!("Failed to query worktree issues: {}", e))?;

    let mut issues = Vec::new();
    for row in rows {
        issues.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(issues)
}

pub fn unlink_worktree(conn: &Connection, worktree_path: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM worktree_issues WHERE worktree_path = ?1",
        params![worktree_path],
    )
    .map_err(|e| format!("Failed to unlink worktree: {}", e))?;
    Ok(())
}
