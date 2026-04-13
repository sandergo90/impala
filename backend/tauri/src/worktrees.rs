use rusqlite::{params, Connection};
use std::collections::HashMap;

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS worktrees (
            path  TEXT PRIMARY KEY,
            title TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to initialize worktrees table: {}", e))
}

pub fn is_main_branch(branch: &str) -> bool {
    matches!(branch, "main" | "master" | "develop")
}

/// Derive a human-readable title from a branch name
/// (e.g. `feature/ENG-123-add-auth` → `Add auth`).
pub fn default_title_from_branch(branch: &str) -> String {
    let after_slash = branch.rsplit('/').next().unwrap_or(branch);
    let without_ticket = strip_ticket_prefix(after_slash);
    let spaced: String = without_ticket
        .chars()
        .map(|c| if c == '-' || c == '_' { ' ' } else { c })
        .collect();
    let trimmed = spaced.trim();
    if trimmed.is_empty() {
        return branch.to_string();
    }
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => branch.to_string(),
    }
}

/// Match `ENG-123-`, `ABC-42-`, etc. at the start of the string and remove it.
fn strip_ticket_prefix(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut i = 0;
    // [A-Z]
    if i >= bytes.len() || !(bytes[i].is_ascii_uppercase()) {
        return s;
    }
    i += 1;
    // [A-Z0-9]+
    let letters_start = i;
    while i < bytes.len() && (bytes[i].is_ascii_uppercase() || bytes[i].is_ascii_digit()) {
        i += 1;
    }
    if i == letters_start {
        return s;
    }
    // `-`
    if i >= bytes.len() || bytes[i] != b'-' {
        return s;
    }
    i += 1;
    // \d+
    let digits_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits_start {
        return s;
    }
    // `-`
    if i >= bytes.len() || bytes[i] != b'-' {
        return s;
    }
    i += 1;
    &s[i..]
}

pub fn get_all_titles(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT path, title FROM worktrees")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| format!("Failed to query worktree titles: {}", e))?;
    let mut map = HashMap::new();
    for row in rows {
        let (path, title) = row.map_err(|e| format!("Failed to read row: {}", e))?;
        map.insert(path, title);
    }
    Ok(map)
}

pub fn upsert_title(conn: &Connection, path: &str, title: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO worktrees (path, title) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET title = excluded.title",
        params![path, title],
    )
    .map_err(|e| format!("Failed to upsert worktree title: {}", e))?;
    Ok(())
}

pub fn delete_row(conn: &Connection, path: &str) -> Result<(), String> {
    conn.execute("DELETE FROM worktrees WHERE path = ?1", params![path])
        .map_err(|e| format!("Failed to delete worktree row: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn de_slug_basic() {
        assert_eq!(default_title_from_branch("feature/password-reset"), "Password reset");
        assert_eq!(default_title_from_branch("fix/modal-close-bug"), "Modal close bug");
        assert_eq!(default_title_from_branch("sander/scratch"), "Scratch");
    }

    #[test]
    fn de_slug_ticket_prefix() {
        assert_eq!(default_title_from_branch("ENG-123-add-auth"), "Add auth");
        assert_eq!(default_title_from_branch("feature/ENG-42-new-thing"), "New thing");
    }

    #[test]
    fn de_slug_nested() {
        assert_eq!(default_title_from_branch("team/sub/foo-bar"), "Foo bar");
    }

    #[test]
    fn de_slug_fallback() {
        assert_eq!(default_title_from_branch(""), "");
        assert_eq!(default_title_from_branch("main"), "Main");
    }

    #[test]
    fn de_slug_preserves_acronyms() {
        assert_eq!(default_title_from_branch("feature/api-tokens"), "Api tokens");
    }
}
