use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeIssue {
    pub worktree_path: String,
    pub issue_id: String,
    pub identifier: String,
    pub created_at: String,
}

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS worktree_issues (
            worktree_path TEXT PRIMARY KEY,
            issue_id TEXT NOT NULL,
            identifier TEXT NOT NULL,
            created_at TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to initialize worktree_issues table: {}", e))
}

pub fn link_worktree(
    conn: &Connection,
    worktree_path: &str,
    issue_id: &str,
    identifier: &str,
) -> Result<WorktreeIssue, String> {
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO worktree_issues (worktree_path, issue_id, identifier, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(worktree_path)
         DO UPDATE SET issue_id = excluded.issue_id, identifier = excluded.identifier, created_at = excluded.created_at",
        params![worktree_path, issue_id, identifier, now],
    )
    .map_err(|e| format!("Failed to link worktree to issue: {}", e))?;

    Ok(WorktreeIssue {
        worktree_path: worktree_path.to_string(),
        issue_id: issue_id.to_string(),
        identifier: identifier.to_string(),
        created_at: now,
    })
}

pub fn get_issue_for_worktree(
    conn: &Connection,
    worktree_path: &str,
) -> Result<Option<WorktreeIssue>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT worktree_path, issue_id, identifier, created_at
             FROM worktree_issues WHERE worktree_path = ?1",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let mut rows = stmt
        .query_map(params![worktree_path], |row| {
            Ok(WorktreeIssue {
                worktree_path: row.get(0)?,
                issue_id: row.get(1)?,
                identifier: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| format!("Failed to query worktree issue: {}", e))?;

    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| format!("Failed to read row: {}", e))?)),
        None => Ok(None),
    }
}

pub fn get_all_worktree_issues(
    conn: &Connection,
) -> Result<Vec<WorktreeIssue>, String> {
    let mut stmt = conn
        .prepare("SELECT worktree_path, issue_id, identifier, created_at FROM worktree_issues")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(WorktreeIssue {
                worktree_path: row.get(0)?,
                issue_id: row.get(1)?,
                identifier: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
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
