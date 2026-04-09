use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

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
    let path = data_dir.join("com.impala.app").join("impala.db");
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

fn ensure_plan_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plans (
            id TEXT PRIMARY KEY,
            plan_path TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            title TEXT,
            status TEXT DEFAULT 'pending',
            version INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plans_worktree ON plans(worktree_path);
        CREATE TABLE IF NOT EXISTS plan_annotations (
            id TEXT PRIMARY KEY,
            plan_path TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            line_number INTEGER NOT NULL,
            body TEXT NOT NULL,
            resolved INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plan_annotations_scope ON plan_annotations(plan_path, worktree_path);",
    )
    .map_err(|e| format!("failed to ensure plan tables: {e}"))
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

fn tool_submit_plan_for_review(conn: &Connection, params: &Value) -> Result<Value, String> {
    let plan_path = params
        .get("plan_path")
        .and_then(|v| v.as_str())
        .ok_or("missing required parameter: plan_path")?;

    let title = params.get("title").and_then(|v| v.as_str());

    let worktree_path = params
        .get("worktree_path")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let plan_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // Auto-increment version per plan_path
    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM plans WHERE plan_path = ?1",
            rusqlite::params![plan_path],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO plans (id, plan_path, worktree_path, title, status, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7)",
        rusqlite::params![plan_id, plan_path, worktree_path, title, version, now, now],
    )
    .map_err(|e| e.to_string())?;

    // Poll for status change (blocking)
    let timeout_secs = 300;
    let mut elapsed = 0;

    loop {
        thread::sleep(Duration::from_secs(1));
        elapsed += 1;

        let status: String = conn
            .query_row(
                "SELECT status FROM plans WHERE id = ?1",
                rusqlite::params![plan_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        if status != "pending" {
            // Fetch annotations
            let mut stmt = conn
                .prepare(
                    "SELECT id, plan_path, worktree_path, line_number, body, resolved, created_at, updated_at
                     FROM plan_annotations
                     WHERE plan_path = ?1 AND worktree_path = ?2
                     ORDER BY line_number ASC",
                )
                .map_err(|e| e.to_string())?;

            let rows = stmt
                .query_map(rusqlite::params![plan_path, worktree_path], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "plan_path": row.get::<_, String>(1)?,
                        "worktree_path": row.get::<_, String>(2)?,
                        "line_number": row.get::<_, i64>(3)?,
                        "body": row.get::<_, String>(4)?,
                        "resolved": row.get::<_, i64>(5)? != 0,
                        "created_at": row.get::<_, String>(6)?,
                        "updated_at": row.get::<_, String>(7)?,
                    }))
                })
                .map_err(|e| e.to_string())?;

            let mut annotations = Vec::new();
            for row in rows {
                annotations.push(row.map_err(|e| e.to_string())?);
            }

            return Ok(json!({
                "status": status,
                "plan_id": plan_id,
                "version": version,
                "annotations": annotations
            }));
        }

        if elapsed >= timeout_secs {
            return Ok(json!({
                "status": "timeout",
                "plan_id": plan_id,
                "version": version,
                "message": "Plan review is still pending. Use get_plan_decision to check later."
            }));
        }
    }
}

fn tool_get_plan_decision(conn: &Connection, params: &Value) -> Result<Value, String> {
    let plan_path = params
        .get("plan_path")
        .and_then(|v| v.as_str())
        .ok_or("missing required parameter: plan_path")?;

    let worktree_path = params
        .get("worktree_path")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let plan = conn
        .query_row(
            "SELECT id, plan_path, worktree_path, title, status, version, created_at, updated_at
             FROM plans
             WHERE plan_path = ?1 AND worktree_path = ?2
             ORDER BY version DESC LIMIT 1",
            rusqlite::params![plan_path, worktree_path],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "plan_path": row.get::<_, String>(1)?,
                    "worktree_path": row.get::<_, String>(2)?,
                    "title": row.get::<_, Option<String>>(3)?,
                    "status": row.get::<_, String>(4)?,
                    "version": row.get::<_, i64>(5)?,
                    "created_at": row.get::<_, String>(6)?,
                    "updated_at": row.get::<_, String>(7)?,
                }))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                format!("no plan found for plan_path: {plan_path}")
            }
            _ => e.to_string(),
        })?;

    // Fetch annotations
    let mut stmt = conn
        .prepare(
            "SELECT id, plan_path, worktree_path, line_number, body, resolved, created_at, updated_at
             FROM plan_annotations
             WHERE plan_path = ?1 AND worktree_path = ?2
             ORDER BY line_number ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![plan_path, worktree_path], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "plan_path": row.get::<_, String>(1)?,
                "worktree_path": row.get::<_, String>(2)?,
                "line_number": row.get::<_, i64>(3)?,
                "body": row.get::<_, String>(4)?,
                "resolved": row.get::<_, i64>(5)? != 0,
                "created_at": row.get::<_, String>(6)?,
                "updated_at": row.get::<_, String>(7)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut annotations = Vec::new();
    for row in rows {
        annotations.push(row.map_err(|e| e.to_string())?);
    }

    Ok(json!({
        "plan": plan,
        "annotations": annotations
    }))
}

fn tool_list_plans(conn: &Connection, params: &Value) -> Result<Value, String> {
    let mut sql = String::from(
        "SELECT id, plan_path, worktree_path, title, status, version, created_at, updated_at FROM plans",
    );
    let mut bind_values: Vec<String> = Vec::new();

    if let Some(v) = params.get("worktree_path").and_then(|v| v.as_str()) {
        sql.push_str(&format!(" WHERE worktree_path = ?{}", bind_values.len() + 1));
        bind_values.push(v.to_string());
    }

    sql.push_str(" ORDER BY created_at DESC");

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = bind_values
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "plan_path": row.get::<_, String>(1)?,
                "worktree_path": row.get::<_, String>(2)?,
                "title": row.get::<_, Option<String>>(3)?,
                "status": row.get::<_, String>(4)?,
                "version": row.get::<_, i64>(5)?,
                "created_at": row.get::<_, String>(6)?,
                "updated_at": row.get::<_, String>(7)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut plans = Vec::new();
    for row in rows {
        plans.push(row.map_err(|e| e.to_string())?);
    }

    Ok(json!(plans))
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
            },
            {
                "name": "submit_plan_for_review",
                "description": "Submit a plan for user review. Blocks until the user approves or requests changes, then returns the decision and all annotations. Times out after 5 minutes with a 'timeout' status.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "plan_path": {
                            "type": "string",
                            "description": "Path to the plan markdown file"
                        },
                        "title": {
                            "type": "string",
                            "description": "Optional title for the plan"
                        },
                        "worktree_path": {
                            "type": "string",
                            "description": "Path to the worktree this plan belongs to"
                        }
                    },
                    "required": ["plan_path"]
                }
            },
            {
                "name": "get_plan_decision",
                "description": "Get the latest plan status and annotations for a plan_path. Use this to check on a plan after a timeout.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "plan_path": {
                            "type": "string",
                            "description": "Path to the plan markdown file"
                        },
                        "worktree_path": {
                            "type": "string",
                            "description": "Path to the worktree this plan belongs to"
                        }
                    },
                    "required": ["plan_path"]
                }
            },
            {
                "name": "list_plans",
                "description": "List all tracked plans, optionally filtered by worktree path.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Filter by worktree path"
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
                "submit_plan_for_review" => {
                    tool_submit_plan_for_review(conn, &tool_args)
                }
                "get_plan_decision" => tool_get_plan_decision(conn, &tool_args),
                "list_plans" => tool_list_plans(conn, &tool_args),
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

    ensure_plan_tables(&conn).unwrap_or_else(|e| {
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
