use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Annotation model
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct Annotation {
    id: String,
    repo_path: String,
    file_path: String,
    commit_hash: String,
    line_number: i64,
    side: String,
    body: String,
    resolved: bool,
    created_at: String,
    updated_at: String,
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

fn db_path() -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir().ok_or("could not determine data directory")?;
    let path = data_dir.join("com.impala.app").join("annotations.db");
    if !path.exists() {
        return Err(format!("database not found at {}", path.display()));
    }
    Ok(path)
}

fn open_db() -> Result<Connection, String> {
    let path = db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("failed to open database: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("failed to set WAL mode: {e}"))?;
    Ok(conn)
}

fn row_to_annotation(row: &rusqlite::Row) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get(0)?,
        repo_path: row.get(1)?,
        file_path: row.get(2)?,
        commit_hash: row.get(3)?,
        line_number: row.get(4)?,
        side: row.get(5)?,
        body: row.get(6)?,
        resolved: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

fn tool_list_annotations(conn: &Connection, params: &Value) -> Result<Value, String> {
    let mut sql = String::from(
        "SELECT id, repo_path, file_path, commit_hash, line_number, side, body, resolved, created_at, updated_at FROM annotations WHERE resolved = 0",
    );
    let mut bind_values: Vec<String> = Vec::new();

    if let Some(v) = params.get("repo_path").and_then(|v| v.as_str()) {
        sql.push_str(&format!(" AND repo_path = ?{}", bind_values.len() + 1));
        bind_values.push(v.to_string());
    }
    if let Some(v) = params.get("file_path").and_then(|v| v.as_str()) {
        sql.push_str(&format!(" AND file_path = ?{}", bind_values.len() + 1));
        bind_values.push(v.to_string());
    }
    if let Some(v) = params.get("commit_hash").and_then(|v| v.as_str()) {
        sql.push_str(&format!(" AND commit_hash = ?{}", bind_values.len() + 1));
        bind_values.push(v.to_string());
    }

    sql.push_str(" ORDER BY created_at DESC");

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = bind_values
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_refs.as_slice(), row_to_annotation)
        .map_err(|e| e.to_string())?;

    let mut annotations = Vec::new();
    for row in rows {
        annotations.push(row.map_err(|e| e.to_string())?);
    }

    Ok(json!(annotations))
}

fn tool_resolve_annotation(conn: &Connection, params: &Value) -> Result<Value, String> {
    let id = params
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("missing required parameter: id")?;

    let now = chrono::Utc::now().to_rfc3339();
    let updated = conn
        .execute(
            "UPDATE annotations SET resolved = 1, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )
        .map_err(|e| e.to_string())?;

    if updated == 0 {
        return Err(format!("annotation not found: {id}"));
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, repo_path, file_path, commit_hash, line_number, side, body, resolved, created_at, updated_at FROM annotations WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let annotation = stmt
        .query_row(rusqlite::params![id], row_to_annotation)
        .map_err(|e| e.to_string())?;

    Ok(json!(annotation))
}

fn tool_list_files_with_annotations(conn: &Connection, params: &Value) -> Result<Value, String> {
    let mut sql = String::from(
        "SELECT file_path, COUNT(*) as count FROM annotations WHERE resolved = 0",
    );
    let mut bind_values: Vec<String> = Vec::new();

    if let Some(v) = params.get("repo_path").and_then(|v| v.as_str()) {
        sql.push_str(&format!(" AND repo_path = ?{}", bind_values.len() + 1));
        bind_values.push(v.to_string());
    }
    if let Some(v) = params.get("commit_hash").and_then(|v| v.as_str()) {
        sql.push_str(&format!(" AND commit_hash = ?{}", bind_values.len() + 1));
        bind_values.push(v.to_string());
    }

    sql.push_str(" GROUP BY file_path ORDER BY count DESC");

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = bind_values
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok(json!({
                "file_path": row.get::<_, String>(0)?,
                "count": row.get::<_, i64>(1)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    for row in rows {
        files.push(row.map_err(|e| e.to_string())?);
    }

    Ok(json!(files))
}

// ---------------------------------------------------------------------------
// MCP protocol definitions
// ---------------------------------------------------------------------------

fn tool_definitions() -> Value {
    json!({
        "tools": [
            {
                "name": "list_annotations",
                "description": "List code review annotations, optionally filtered by repo, file, or commit.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_path": {
                            "type": "string",
                            "description": "Filter by repository path"
                        },
                        "file_path": {
                            "type": "string",
                            "description": "Filter by file path"
                        },
                        "commit_hash": {
                            "type": "string",
                            "description": "Filter by commit hash"
                        }
                    }
                }
            },
            {
                "name": "resolve_annotation",
                "description": "Mark an annotation as resolved.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "The annotation ID to resolve"
                        }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "list_files_with_annotations",
                "description": "List files that have unresolved annotations, with counts.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_path": {
                            "type": "string",
                            "description": "Filter by repository path"
                        },
                        "commit_hash": {
                            "type": "string",
                            "description": "Filter by commit hash"
                        }
                    }
                }
            }
        ]
    })
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": "impala-mcp",
            "version": "0.1.0"
        }
    })
}

// ---------------------------------------------------------------------------
// JSON-RPC handling
// ---------------------------------------------------------------------------

fn make_response(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn make_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

fn make_tool_result(text: &str) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": text
            }
        ]
    })
}

fn make_tool_error(text: &str) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": text
            }
        ],
        "isError": true
    })
}

fn handle_request(conn: &Connection, request: &Value) -> Option<Value> {
    // Notifications have no id — don't respond
    let id = match request.get("id") {
        Some(id) => id.clone(),
        None => return None,
    };

    let method = match request.get("method").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => return Some(make_error(id, -32600, "invalid request: missing method")),
    };

    let params = request.get("params").cloned().unwrap_or(json!({}));

    match method {
        "initialize" => Some(make_response(id, initialize_result())),

        "tools/list" => Some(make_response(id, tool_definitions())),

        "tools/call" => {
            let tool_name = match params.get("name").and_then(|n| n.as_str()) {
                Some(n) => n,
                None => {
                    return Some(make_error(id, -32602, "missing tool name"));
                }
            };
            let tool_args = params.get("arguments").cloned().unwrap_or(json!({}));

            let result = match tool_name {
                "list_annotations" => tool_list_annotations(conn, &tool_args),
                "resolve_annotation" => tool_resolve_annotation(conn, &tool_args),
                "list_files_with_annotations" => {
                    tool_list_files_with_annotations(conn, &tool_args)
                }
                _ => {
                    return Some(make_response(
                        id,
                        make_tool_error(&format!("unknown tool: {tool_name}")),
                    ));
                }
            };

            match result {
                Ok(value) => {
                    let text = serde_json::to_string_pretty(&value).unwrap_or_default();
                    Some(make_response(id, make_tool_result(&text)))
                }
                Err(e) => Some(make_response(id, make_tool_error(&e))),
            }
        }

        _ => Some(make_error(
            id,
            -32601,
            &format!("method not found: {method}"),
        )),
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let conn = open_db().unwrap_or_else(|e| {
        eprintln!("impala-mcp: {}", e);
        std::process::exit(1);
    });

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                let err = make_error(Value::Null, -32700, &format!("parse error: {e}"));
                let _ = writeln!(stdout, "{}", err);
                let _ = stdout.flush();
                continue;
            }
        };

        if let Some(response) = handle_request(&conn, &request) {
            let _ = writeln!(stdout, "{}", response);
            let _ = stdout.flush();
        }
    }
}
