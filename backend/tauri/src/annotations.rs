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
    pub code_context: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewAnnotation {
    pub repo_path: String,
    pub file_path: String,
    pub commit_hash: String,
    pub line_number: i64,
    pub side: String,
    pub body: String,
    pub code_context: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAnnotation {
    pub body: Option<String>,
    pub resolved: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BrowserAnnotation {
    pub id: String,
    pub repo_path: String,
    pub url: String,
    pub selector: String,
    pub element: String,
    pub body: String,
    pub screenshot_path: Option<String>,
    pub resolved: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewBrowserAnnotation {
    pub repo_path: String,
    pub url: String,
    pub selector: String,
    pub element: String,
    pub body: String,
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
            updated_at TEXT NOT NULL,
            code_context TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_annotations_scope ON annotations(repo_path, file_path, commit_hash);",
    )
    .map_err(|e| format!("Failed to initialize database: {}", e))?;

    // Migration: add code_context column if missing (existing DBs)
    let has_code_context = conn
        .prepare("SELECT code_context FROM annotations LIMIT 0")
        .is_ok();
    if !has_code_context {
        conn.execute_batch("ALTER TABLE annotations ADD COLUMN code_context TEXT;")
            .map_err(|e| format!("Failed to add code_context column: {}", e))?;
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS browser_annotations (
            id TEXT PRIMARY KEY,
            repo_path TEXT NOT NULL,
            url TEXT NOT NULL,
            selector TEXT NOT NULL,
            element TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL,
            screenshot_path TEXT,
            resolved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_browser_annotations_scope ON browser_annotations(repo_path, resolved);",
    )
    .map_err(|e| format!("Failed to initialize browser_annotations: {}", e))?;

    Ok(())
}

pub fn create_browser_annotation(
    conn: &Connection,
    new: NewBrowserAnnotation,
    screenshot_path: Option<String>,
) -> Result<BrowserAnnotation, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO browser_annotations (id, repo_path, url, selector, element, body, screenshot_path, resolved, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
        params![id, new.repo_path, new.url, new.selector, new.element, new.body, screenshot_path, now, now],
    )
    .map_err(|e| format!("Failed to create browser annotation: {}", e))?;

    Ok(BrowserAnnotation {
        id,
        repo_path: new.repo_path,
        url: new.url,
        selector: new.selector,
        element: new.element,
        body: new.body,
        screenshot_path,
        resolved: false,
        created_at: now.clone(),
        updated_at: now,
    })
}

fn row_to_browser_annotation(row: &rusqlite::Row) -> rusqlite::Result<BrowserAnnotation> {
    let resolved_int: i64 = row.get(7)?;
    Ok(BrowserAnnotation {
        id: row.get(0)?,
        repo_path: row.get(1)?,
        url: row.get(2)?,
        selector: row.get(3)?,
        element: row.get(4)?,
        body: row.get(5)?,
        screenshot_path: row.get(6)?,
        resolved: resolved_int != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

const BROWSER_ANNOTATION_COLS: &str =
    "id, repo_path, url, selector, element, body, screenshot_path, resolved, created_at, updated_at";

pub fn list_browser_annotations(
    conn: &Connection,
    repo_path: &str,
    include_resolved: bool,
) -> Result<Vec<BrowserAnnotation>, String> {
    let mut sql = format!(
        "SELECT {BROWSER_ANNOTATION_COLS} FROM browser_annotations WHERE repo_path = ?1"
    );
    if !include_resolved {
        sql.push_str(" AND resolved = 0");
    }
    sql.push_str(" ORDER BY created_at ASC");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    let rows = stmt
        .query_map(params![repo_path], row_to_browser_annotation)
        .map_err(|e| format!("Failed to query browser annotations: {}", e))?;

    let mut annotations = Vec::new();
    for row in rows {
        annotations.push(row.map_err(|e| format!("Failed to read browser annotation: {}", e))?);
    }
    Ok(annotations)
}

pub fn resolve_browser_annotation(conn: &Connection, id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let rows_affected = conn
        .execute(
            "UPDATE browser_annotations SET resolved = 1, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )
        .map_err(|e| format!("Failed to resolve browser annotation: {}", e))?;
    if rows_affected == 0 {
        return Err(format!("Browser annotation not found: {}", id));
    }
    Ok(())
}

/// Delete the row and hand back its screenshot_path so the caller can
/// remove the file — the DB layer has no filesystem access.
pub fn delete_browser_annotation(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let screenshot_path: Option<String> = conn
        .query_row(
            "SELECT screenshot_path FROM browser_annotations WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|_| format!("Browser annotation not found: {}", id))?;
    conn.execute(
        "DELETE FROM browser_annotations WHERE id = ?1",
        params![id],
    )
    .map_err(|e| format!("Failed to delete browser annotation: {}", e))?;
    Ok(screenshot_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_annotation_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        let created = create_browser_annotation(
            &conn,
            NewBrowserAnnotation {
                repo_path: "/wt".into(),
                url: "http://localhost:3000/".into(),
                selector: "#app > button.save".into(),
                element: "<button class=\"save\">Save</button>".into(),
                body: "make this primary-colored".into(),
            },
            Some("/tmp/shot.png".into()),
        )
        .unwrap();

        let listed = list_browser_annotations(&conn, "/wt", false).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
        assert_eq!(listed[0].screenshot_path.as_deref(), Some("/tmp/shot.png"));

        assert!(list_browser_annotations(&conn, "/other", false)
            .unwrap()
            .is_empty());

        resolve_browser_annotation(&conn, &created.id).unwrap();
        assert!(list_browser_annotations(&conn, "/wt", false)
            .unwrap()
            .is_empty());
        let all = list_browser_annotations(&conn, "/wt", true).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].resolved);

        assert!(resolve_browser_annotation(&conn, "missing").is_err());

        assert_eq!(
            delete_browser_annotation(&conn, &created.id).unwrap().as_deref(),
            Some("/tmp/shot.png")
        );
        assert!(list_browser_annotations(&conn, "/wt", true)
            .unwrap()
            .is_empty());
        assert!(delete_browser_annotation(&conn, &created.id).is_err());
    }
}

pub fn create_annotation(conn: &Connection, new: NewAnnotation) -> Result<Annotation, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO annotations (id, repo_path, file_path, commit_hash, line_number, side, body, resolved, created_at, updated_at, code_context)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10)",
        params![id, new.repo_path, new.file_path, new.commit_hash, new.line_number, new.side, new.body, now, now, new.code_context],
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
        code_context: new.code_context,
    })
}

pub fn list_annotations(
    conn: &Connection,
    repo_path: &str,
    file_path: Option<&str>,
    commit_hash: Option<&str>,
) -> Result<Vec<Annotation>, String> {
    let mut sql = String::from("SELECT id, repo_path, file_path, commit_hash, line_number, side, body, resolved, created_at, updated_at, code_context FROM annotations WHERE repo_path = ?1");
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

    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> =
        vec![Box::new(repo_path.to_string())];
    if let Some(fp) = file_path {
        params_vec.push(Box::new(fp.to_string()));
    }
    if let Some(ch) = commit_hash {
        params_vec.push(Box::new(ch.to_string()));
    }

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params_vec.iter().map(|p| p.as_ref()).collect();

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
                code_context: row.get(10)?,
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

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params_vec.iter().map(|p| p.as_ref()).collect();

    let rows_affected = conn
        .execute(&sql, param_refs.as_slice())
        .map_err(|e| format!("Failed to update annotation: {}", e))?;

    if rows_affected == 0 {
        return Err(format!("Annotation not found: {}", id));
    }

    // Fetch and return the updated annotation
    conn.query_row(
        "SELECT id, repo_path, file_path, commit_hash, line_number, side, body, resolved, created_at, updated_at, code_context FROM annotations WHERE id = ?1",
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
                code_context: row.get(10)?,
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
