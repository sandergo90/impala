use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlanAnnotation {
    pub id: String,
    pub plan_path: String,
    pub worktree_path: String,
    pub file_name: Option<String>,
    pub original_text: String,
    pub highlight_source: Option<String>,
    pub body: String,
    pub resolved: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewPlanAnnotation {
    pub plan_path: String,
    pub worktree_path: String,
    pub file_name: Option<String>,
    pub original_text: String,
    pub highlight_source: Option<String>,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePlanAnnotation {
    pub body: Option<String>,
    pub resolved: Option<bool>,
}

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS plan_annotations;
        CREATE TABLE plan_annotations (
            id TEXT PRIMARY KEY,
            plan_path TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            file_name TEXT,
            original_text TEXT NOT NULL,
            highlight_source TEXT,
            body TEXT NOT NULL,
            resolved INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_annotations_scope ON plan_annotations(plan_path, worktree_path);",
    )
    .map_err(|e| format!("Failed to initialize plan_annotations table: {}", e))
}

pub fn create_plan_annotation(
    conn: &Connection,
    new: NewPlanAnnotation,
) -> Result<PlanAnnotation, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO plan_annotations (id, plan_path, worktree_path, file_name, original_text, highlight_source, body, resolved, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
        params![id, new.plan_path, new.worktree_path, new.file_name, new.original_text, new.highlight_source, new.body, now, now],
    )
    .map_err(|e| format!("Failed to create plan annotation: {}", e))?;

    Ok(PlanAnnotation {
        id,
        plan_path: new.plan_path,
        worktree_path: new.worktree_path,
        file_name: new.file_name,
        original_text: new.original_text,
        highlight_source: new.highlight_source,
        body: new.body,
        resolved: false,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn list_plan_annotations(
    conn: &Connection,
    plan_path: &str,
    worktree_path: Option<&str>,
) -> Result<Vec<PlanAnnotation>, String> {
    let mut sql = String::from(
        "SELECT id, plan_path, worktree_path, file_name, original_text, highlight_source, body, resolved, created_at, updated_at
         FROM plan_annotations WHERE plan_path = ?1",
    );

    if worktree_path.is_some() {
        sql.push_str(" AND worktree_path = ?2");
    }
    sql.push_str(" ORDER BY created_at ASC");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> =
        vec![Box::new(plan_path.to_string())];
    if let Some(wt) = worktree_path {
        params_vec.push(Box::new(wt.to_string()));
    }
    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params_vec.iter().map(|p| p.as_ref()).collect();

    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            let resolved_int: i64 = row.get(7)?;
            Ok(PlanAnnotation {
                id: row.get(0)?,
                plan_path: row.get(1)?,
                worktree_path: row.get(2)?,
                file_name: row.get(3)?,
                original_text: row.get(4)?,
                highlight_source: row.get(5)?,
                body: row.get(6)?,
                resolved: resolved_int != 0,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| format!("Failed to query plan annotations: {}", e))?;

    let mut annotations = Vec::new();
    for row in rows {
        annotations.push(row.map_err(|e| format!("Failed to read plan annotation: {}", e))?);
    }
    Ok(annotations)
}

pub fn update_plan_annotation(
    conn: &Connection,
    id: &str,
    changes: UpdatePlanAnnotation,
) -> Result<PlanAnnotation, String> {
    let now = chrono::Utc::now().to_rfc3339();

    let mut sets = vec!["updated_at = ?1".to_string()];
    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now.clone())];
    let mut param_index = 2;

    if let Some(ref body) = changes.body {
        sets.push(format!("body = ?{}", param_index));
        params_vec.push(Box::new(body.clone()));
        param_index += 1;
    }
    if let Some(resolved) = changes.resolved {
        sets.push(format!("resolved = ?{}", param_index));
        params_vec.push(Box::new(resolved as i64));
        param_index += 1;
    }

    let sql = format!(
        "UPDATE plan_annotations SET {} WHERE id = ?{}",
        sets.join(", "),
        param_index
    );
    params_vec.push(Box::new(id.to_string()));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params_vec.iter().map(|p| p.as_ref()).collect();

    let rows_affected = conn
        .execute(&sql, param_refs.as_slice())
        .map_err(|e| format!("Failed to update plan annotation: {}", e))?;

    if rows_affected == 0 {
        return Err(format!("Plan annotation not found: {}", id));
    }

    conn.query_row(
        "SELECT id, plan_path, worktree_path, file_name, original_text, highlight_source, body, resolved, created_at, updated_at
         FROM plan_annotations WHERE id = ?1",
        params![id],
        |row| {
            let resolved_int: i64 = row.get(7)?;
            Ok(PlanAnnotation {
                id: row.get(0)?,
                plan_path: row.get(1)?,
                worktree_path: row.get(2)?,
                file_name: row.get(3)?,
                original_text: row.get(4)?,
                highlight_source: row.get(5)?,
                body: row.get(6)?,
                resolved: resolved_int != 0,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .map_err(|e| format!("Failed to fetch updated plan annotation: {}", e))
}

pub fn delete_plan_annotation(conn: &Connection, id: &str) -> Result<(), String> {
    let rows_affected = conn
        .execute(
            "DELETE FROM plan_annotations WHERE id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to delete plan annotation: {}", e))?;

    if rows_affected == 0 {
        return Err(format!("Plan annotation not found: {}", id));
    }
    Ok(())
}
