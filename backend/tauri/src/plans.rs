use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Plan {
    pub id: String,
    pub plan_path: String,
    pub worktree_path: String,
    pub title: Option<String>,
    pub status: String,
    pub version: i64,
    pub content: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewPlan {
    pub plan_path: String,
    pub worktree_path: String,
    pub title: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePlan {
    pub status: Option<String>,
    pub title: Option<String>,
}

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plans (
            id TEXT PRIMARY KEY,
            plan_path TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            title TEXT,
            status TEXT DEFAULT 'pending',
            version INTEGER DEFAULT 1,
            content TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plans_worktree ON plans(worktree_path);",
    )
    .map_err(|e| format!("Failed to initialize plans table: {}", e))?;

    // Migration: add content column if missing (existing DBs)
    let has_content = conn.prepare("SELECT content FROM plans LIMIT 0").is_ok();
    if !has_content {
        conn.execute_batch("ALTER TABLE plans ADD COLUMN content TEXT;")
            .map_err(|e| format!("Failed to add content column: {}", e))?;
    }

    Ok(())
}

pub fn create_plan(conn: &Connection, new: NewPlan) -> Result<Plan, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // Auto-increment version for same plan_path
    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM plans WHERE plan_path = ?1",
            params![new.plan_path],
            |row| row.get(0),
        )
        .unwrap_or(0)
        + 1;

    conn.execute(
        "INSERT INTO plans (id, plan_path, worktree_path, title, status, version, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8)",
        params![id, new.plan_path, new.worktree_path, new.title, version, new.content, now, now],
    )
    .map_err(|e| format!("Failed to create plan: {}", e))?;

    Ok(Plan {
        id,
        plan_path: new.plan_path,
        worktree_path: new.worktree_path,
        title: new.title,
        status: "pending".to_string(),
        version,
        content: new.content,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn list_plans(
    conn: &Connection,
    worktree_path: &str,
) -> Result<Vec<Plan>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, plan_path, worktree_path, title, status, version, content, created_at, updated_at
             FROM plans WHERE worktree_path = ?1 ORDER BY created_at DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map(params![worktree_path], |row| {
            Ok(Plan {
                id: row.get(0)?,
                plan_path: row.get(1)?,
                worktree_path: row.get(2)?,
                title: row.get(3)?,
                status: row.get(4)?,
                version: row.get(5)?,
                content: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|e| format!("Failed to query plans: {}", e))?;

    let mut plans = Vec::new();
    for row in rows {
        plans.push(row.map_err(|e| format!("Failed to read plan: {}", e))?);
    }
    Ok(plans)
}

pub fn get_plan(conn: &Connection, id: &str) -> Result<Plan, String> {
    conn.query_row(
        "SELECT id, plan_path, worktree_path, title, status, version, content, created_at, updated_at
         FROM plans WHERE id = ?1",
        params![id],
        |row| {
            Ok(Plan {
                id: row.get(0)?,
                plan_path: row.get(1)?,
                worktree_path: row.get(2)?,
                title: row.get(3)?,
                status: row.get(4)?,
                version: row.get(5)?,
                content: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    )
    .map_err(|e| format!("Plan not found: {}", e))
}

pub fn update_plan(
    conn: &Connection,
    id: &str,
    changes: UpdatePlan,
) -> Result<Plan, String> {
    let now = chrono::Utc::now().to_rfc3339();

    let mut sets = vec!["updated_at = ?1".to_string()];
    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now.clone())];
    let mut param_index = 2;

    if let Some(ref status) = changes.status {
        sets.push(format!("status = ?{}", param_index));
        params_vec.push(Box::new(status.clone()));
        param_index += 1;
    }
    if let Some(ref title) = changes.title {
        sets.push(format!("title = ?{}", param_index));
        params_vec.push(Box::new(title.clone()));
        param_index += 1;
    }

    let sql = format!(
        "UPDATE plans SET {} WHERE id = ?{}",
        sets.join(", "),
        param_index
    );
    params_vec.push(Box::new(id.to_string()));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params_vec.iter().map(|p| p.as_ref()).collect();

    let rows_affected = conn
        .execute(&sql, param_refs.as_slice())
        .map_err(|e| format!("Failed to update plan: {}", e))?;

    if rows_affected == 0 {
        return Err(format!("Plan not found: {}", id));
    }

    get_plan(conn, id)
}
