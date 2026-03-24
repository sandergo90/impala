use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Annotation {
    pub id: String,
    pub repo_path: String,
    pub file_path: String,
    pub commit_hash: String,
    pub line_number: i64,
    pub side: String,
    pub body: String,
    pub resolved: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewAnnotation {
    pub repo_path: String,
    pub file_path: String,
    pub commit_hash: String,
    pub line_number: i64,
    pub side: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAnnotation {
    pub body: Option<String>,
    pub resolved: Option<bool>,
}

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS annotations (
            id TEXT PRIMARY KEY,
            repo_path TEXT NOT NULL,
            file_path TEXT NOT NULL,
            commit_hash TEXT NOT NULL,
            line_number INTEGER NOT NULL,
            side TEXT NOT NULL,
            body TEXT NOT NULL,
            resolved INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_annotations_scope ON annotations(repo_path, file_path, commit_hash);",
    )
    .map_err(|e| format!("Failed to initialize database: {}", e))
}

pub fn create_annotation(conn: &Connection, new: NewAnnotation) -> Result<Annotation, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO annotations (id, repo_path, file_path, commit_hash, line_number, side, body, resolved, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
        params![id, new.repo_path, new.file_path, new.commit_hash, new.line_number, new.side, new.body, now, now],
    )
    .map_err(|e| format!("Failed to create annotation: {}", e))?;

    Ok(Annotation {
        id,
        repo_path: new.repo_path,
        file_path: new.file_path,
        commit_hash: new.commit_hash,
        line_number: new.line_number,
        side: new.side,
        body: new.body,
        resolved: false,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn list_annotations(
    conn: &Connection,
    repo_path: &str,
    file_path: Option<&str>,
    commit_hash: Option<&str>,
) -> Result<Vec<Annotation>, String> {
    let mut sql = String::from("SELECT id, repo_path, file_path, commit_hash, line_number, side, body, resolved, created_at, updated_at FROM annotations WHERE repo_path = ?1");
    let mut param_index = 2;

    if file_path.is_some() {
        sql.push_str(&format!(" AND file_path = ?{}", param_index));
        param_index += 1;
    }
    if commit_hash.is_some() {
        sql.push_str(&format!(" AND commit_hash = ?{}", param_index));
    }
    sql.push_str(" ORDER BY created_at ASC");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(repo_path.to_string())];
    if let Some(fp) = file_path {
        params_vec.push(Box::new(fp.to_string()));
    }
    if let Some(ch) = commit_hash {
        params_vec.push(Box::new(ch.to_string()));
    }

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            let resolved_int: i64 = row.get(7)?;
            Ok(Annotation {
                id: row.get(0)?,
                repo_path: row.get(1)?,
                file_path: row.get(2)?,
                commit_hash: row.get(3)?,
                line_number: row.get(4)?,
                side: row.get(5)?,
                body: row.get(6)?,
                resolved: resolved_int != 0,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| format!("Failed to query annotations: {}", e))?;

    let mut annotations = Vec::new();
    for row in rows {
        annotations.push(row.map_err(|e| format!("Failed to read annotation: {}", e))?);
    }

    Ok(annotations)
}

pub fn update_annotation(
    conn: &Connection,
    id: &str,
    changes: UpdateAnnotation,
) -> Result<Annotation, String> {
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
        "UPDATE annotations SET {} WHERE id = ?{}",
        sets.join(", "),
        param_index
    );
    params_vec.push(Box::new(id.to_string()));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    let rows_affected = conn
        .execute(&sql, param_refs.as_slice())
        .map_err(|e| format!("Failed to update annotation: {}", e))?;

    if rows_affected == 0 {
        return Err(format!("Annotation not found: {}", id));
    }

    // Fetch and return the updated annotation
    conn.query_row(
        "SELECT id, repo_path, file_path, commit_hash, line_number, side, body, resolved, created_at, updated_at FROM annotations WHERE id = ?1",
        params![id],
        |row| {
            let resolved_int: i64 = row.get(7)?;
            Ok(Annotation {
                id: row.get(0)?,
                repo_path: row.get(1)?,
                file_path: row.get(2)?,
                commit_hash: row.get(3)?,
                line_number: row.get(4)?,
                side: row.get(5)?,
                body: row.get(6)?,
                resolved: resolved_int != 0,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .map_err(|e| format!("Failed to fetch updated annotation: {}", e))
}

pub fn delete_annotation(conn: &Connection, id: &str) -> Result<(), String> {
    let rows_affected = conn
        .execute("DELETE FROM annotations WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete annotation: {}", e))?;

    if rows_affected == 0 {
        return Err(format!("Annotation not found: {}", id));
    }

    Ok(())
}
