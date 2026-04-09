use rusqlite::{params, Connection};

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings (
            key   TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'global',
            value TEXT NOT NULL,
            PRIMARY KEY (key, scope)
        );
        CREATE TABLE IF NOT EXISTS projects (
            path TEXT PRIMARY KEY
        );",
    )
    .map_err(|e| format!("Failed to initialize settings tables: {}", e))
}

pub fn get_setting(conn: &Connection, key: &str, scope: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1 AND scope = ?2")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let mut rows = stmt
        .query_map(params![key, scope], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query setting: {}", e))?;

    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| format!("Failed to read row: {}", e))?)),
        None => Ok(None),
    }
}

pub fn set_setting(conn: &Connection, key: &str, scope: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, scope, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(key, scope) DO UPDATE SET value = excluded.value",
        params![key, scope, value],
    )
    .map_err(|e| format!("Failed to set setting: {}", e))?;
    Ok(())
}

pub fn delete_setting(conn: &Connection, key: &str, scope: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM settings WHERE key = ?1 AND scope = ?2",
        params![key, scope],
    )
    .map_err(|e| format!("Failed to delete setting: {}", e))?;
    Ok(())
}

pub fn load_projects(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT path FROM projects ORDER BY path")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query projects: {}", e))?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(projects)
}

pub fn save_projects(conn: &Connection, projects: &[String]) -> Result<(), String> {
    conn.execute("DELETE FROM projects", [])
        .map_err(|e| format!("Failed to clear projects: {}", e))?;

    let mut stmt = conn
        .prepare("INSERT INTO projects (path) VALUES (?1)")
        .map_err(|e| format!("Failed to prepare insert: {}", e))?;

    for path in projects {
        stmt.execute(params![path])
            .map_err(|e| format!("Failed to insert project: {}", e))?;
    }
    Ok(())
}
