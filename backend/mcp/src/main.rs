mod observability;

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
    let path = data_dir.join("be.kodeus.impala").join("impala.db");
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

fn param_or_cwd(params: &Value, key: &str) -> Result<String, String> {
    if let Some(v) = params.get(key).and_then(|v| v.as_str()) {
        return Ok(v.to_string());
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("could not determine current directory: {e}"))
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

    let repo_path = param_or_cwd(params, "repo_path")?;
    sql.push_str(&format!(" AND repo_path = ?{}", bind_values.len() + 1));
    bind_values.push(repo_path.clone());
    let file_scoped = params.get("file_path").and_then(|v| v.as_str()).is_some()
        || params.get("commit_hash").and_then(|v| v.as_str()).is_some();
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

    let mut items: Vec<Value> = Vec::new();
    for row in rows {
        let annotation = row.map_err(|e| e.to_string())?;
        let mut value = json!(annotation);
        value["kind"] = json!("code");
        items.push(value);
    }

    // Browser annotations aren't file- or commit-scoped; include them only in
    // unfiltered listings. Tolerate a missing table (DB from an app version
    // that predates browser annotations).
    if !file_scoped {
        items.extend(list_browser_annotation_values(conn, &repo_path));
    }

    Ok(json!(items))
}

fn list_browser_annotation_values(conn: &Connection, repo_path: &str) -> Vec<Value> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, repo_path, url, selector, element, body, screenshot_path, resolved, created_at, updated_at
         FROM browser_annotations WHERE resolved = 0 AND repo_path = ?1 ORDER BY created_at DESC",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![repo_path], |row| {
        Ok(json!({
            "kind": "browser",
            "id": row.get::<_, String>(0)?,
            "repo_path": row.get::<_, String>(1)?,
            "url": row.get::<_, String>(2)?,
            "selector": row.get::<_, String>(3)?,
            "element": row.get::<_, String>(4)?,
            "body": row.get::<_, String>(5)?,
            "has_screenshot": row.get::<_, Option<String>>(6)?.is_some(),
            "resolved": row.get::<_, i64>(7)? != 0,
            "created_at": row.get::<_, String>(8)?,
            "updated_at": row.get::<_, String>(9)?,
        }))
    }) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
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
        // Not a code annotation — try the browser table before failing.
        let browser_updated = conn
            .execute(
                "UPDATE browser_annotations SET resolved = 1, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, id],
            )
            .unwrap_or(0);
        if browser_updated == 0 {
            return Err(format!("annotation not found: {id}"));
        }
        return Ok(json!({ "kind": "browser", "id": id, "resolved": true }));
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

fn tool_browser_annotation_screenshot(conn: &Connection, params: &Value) -> Result<String, String> {
    let id = params
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("missing required parameter: id")?;
    let path: Option<String> = conn
        .query_row(
            "SELECT screenshot_path FROM browser_annotations WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|_| format!("browser annotation not found: {id}"))?;
    let path = path.ok_or("this annotation has no screenshot")?;
    let bytes =
        std::fs::read(&path).map_err(|e| format!("could not read screenshot: {e}"))?;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok(STANDARD.encode(bytes))
}

fn tool_list_files_with_annotations(conn: &Connection, params: &Value) -> Result<Value, String> {
    let mut sql = String::from(
        "SELECT file_path, COUNT(*) as count FROM annotations WHERE resolved = 0",
    );
    let mut bind_values: Vec<String> = Vec::new();

    let repo_path = param_or_cwd(params, "repo_path")?;
    sql.push_str(&format!(" AND repo_path = ?{}", bind_values.len() + 1));
    bind_values.push(repo_path.clone());
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

    // Not file-scoped, but the overview should mention them (0 when the table
    // doesn't exist yet).
    let browser_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM browser_annotations WHERE resolved = 0 AND repo_path = ?1",
            rusqlite::params![repo_path],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Ok(json!({ "files": files, "browser_annotation_count": browser_count }))
}

// ---------------------------------------------------------------------------
// Browser tools — talk to the running Impala app via its hook server. The
// port is written to ~/.impala/hook-port on every app start (hook_server.rs).
// ---------------------------------------------------------------------------

fn hook_port() -> Result<u16, String> {
    let home = dirs::home_dir().ok_or("could not determine home directory")?;
    let raw = std::fs::read_to_string(home.join(".impala").join("hook-port"))
        .map_err(|_| "Impala isn't running (no hook port file)".to_string())?;
    raw.trim()
        .parse::<u16>()
        .map_err(|_| "invalid hook port file".to_string())
}

fn browser_get(path: &str, params: &[(&str, &str)]) -> Result<Value, String> {
    let port = hook_port()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let url = reqwest::Url::parse_with_params(
        &format!("http://127.0.0.1:{port}{path}"),
        params.iter().copied(),
    )
    .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .map_err(|_| "Impala isn't reachable (is the app running?)".to_string())?;
    let body: Value = resp.json().map_err(|e| format!("bad response: {e}"))?;
    if body.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(body)
    } else {
        Err(body
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown browser error")
            .to_string())
    }
}

fn strip_ok(mut value: Value) -> Value {
    if let Some(obj) = value.as_object_mut() {
        obj.remove("ok");
    }
    value
}

fn tool_browser_page_info(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    browser_get("/browser/page_info", &[("worktree_path", &wt)]).map(strip_ok)
}

fn tool_browser_console(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    let clear = args.get("clear").and_then(|c| c.as_bool()).unwrap_or(false);
    browser_get(
        "/browser/console",
        &[("worktree_path", &wt), ("clear", if clear { "true" } else { "false" })],
    )
    .map(strip_ok)
}

fn tool_browser_navigate(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    let url = args
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or("missing url")?;
    browser_get("/browser/navigate", &[("worktree_path", &wt), ("url", url)]).map(strip_ok)
}

fn tool_browser_click(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    let selector = args
        .get("selector")
        .and_then(|s| s.as_str())
        .ok_or("missing required parameter: selector")?;
    browser_get(
        "/browser/click",
        &[("worktree_path", &wt), ("selector", selector)],
    )
    .map(strip_ok)
}

fn tool_browser_type(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    let selector = args
        .get("selector")
        .and_then(|s| s.as_str())
        .ok_or("missing required parameter: selector")?;
    let text = args
        .get("text")
        .and_then(|t| t.as_str())
        .ok_or("missing required parameter: text")?;
    browser_get(
        "/browser/type",
        &[("worktree_path", &wt), ("selector", selector), ("text", text)],
    )
    .map(strip_ok)
}

fn tool_browser_click_at(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    let x = args
        .get("x")
        .and_then(|v| v.as_f64())
        .ok_or("missing required parameter: x")?;
    let y = args
        .get("y")
        .and_then(|v| v.as_f64())
        .ok_or("missing required parameter: y")?;
    browser_get(
        "/browser/click_at",
        &[
            ("worktree_path", &wt),
            ("x", &x.to_string()),
            ("y", &y.to_string()),
        ],
    )
    .map(strip_ok)
}

fn tool_browser_scroll(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    let dy = args
        .get("dy")
        .and_then(|v| v.as_f64())
        .ok_or("missing required parameter: dy")?;
    let dx = args.get("dx").and_then(|v| v.as_f64()).unwrap_or(0.0);
    browser_get(
        "/browser/scroll",
        &[
            ("worktree_path", &wt),
            ("dy", &dy.to_string()),
            ("dx", &dx.to_string()),
        ],
    )
    .map(strip_ok)
}

fn tool_open_agent_tab(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    let prompt = args
        .get("prompt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or("missing required parameter: prompt")?;
    let agent = args.get("agent").and_then(|value| value.as_str());
    if let Some(agent) = agent {
        if agent != "claude" && agent != "codex" {
            return Err("agent must be 'claude' or 'codex'".to_string());
        }
    }
    let placement = args
        .get("placement")
        .and_then(|value| value.as_str())
        .unwrap_or("auto");
    if !matches!(placement, "auto" | "current" | "left" | "right") {
        return Err("placement must be 'auto', 'current', 'left', or 'right'".to_string());
    }
    let mut params = vec![("worktree_path", wt.as_str()), ("prompt", prompt)];
    if let Some(agent) = agent {
        params.push(("agent", agent));
    }
    let source_pane_id = std::env::var("IMPALA_PANE_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if let Some(source_pane_id) = source_pane_id.as_deref() {
        params.push(("source_pane_id", source_pane_id));
    }
    params.push(("placement", placement));
    browser_get("/agents/open", &params).map(strip_ok)
}

fn tool_browser_screenshot(args: &Value) -> Result<String, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    let body = browser_get("/browser/screenshot", &[("worktree_path", &wt)])?;
    body.get("png_base64")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "screenshot response missing png_base64".to_string())
}

// ---------------------------------------------------------------------------
// MCP protocol definitions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Automation tools — same hook-server transport as the browser tools.
// ---------------------------------------------------------------------------

fn tool_list_automations(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    browser_get("/automations/list", &[("worktree_path", &wt)]).map(strip_ok)
}

fn tool_create_automation(args: &Value) -> Result<Value, String> {
    let wt = param_or_cwd(args, "worktree_path")?;
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("missing name")?;
    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("missing prompt")?;
    let schedule = args
        .get("schedule")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("missing schedule")?;
    let agent = args.get("agent").and_then(|v| v.as_str()).unwrap_or("");
    browser_get(
        "/automations/create",
        &[
            ("worktree_path", &wt),
            ("name", name),
            ("prompt", prompt),
            ("schedule", schedule),
            ("agent", agent),
        ],
    )
    .map(strip_ok)
}

fn tool_update_automation(args: &Value) -> Result<Value, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("missing id")?;
    let mut params = vec![("id", id)];
    for key in ["name", "prompt", "schedule", "agent"] {
        if let Some(value) = args
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            params.push((key, value));
        }
    }
    if params.len() == 1 {
        return Err("nothing to update — pass at least one of name, prompt, schedule, agent".to_string());
    }
    browser_get("/automations/update", &params).map(strip_ok)
}

fn tool_run_automation_now(args: &Value) -> Result<Value, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("missing id")?;
    browser_get("/automations/run_now", &[("id", id)]).map(strip_ok)
}

fn tool_set_automation_enabled(args: &Value) -> Result<Value, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("missing id")?;
    let enabled = args
        .get("enabled")
        .and_then(|v| v.as_bool())
        .ok_or("missing enabled")?;
    browser_get(
        "/automations/set_enabled",
        &[("id", id), ("enabled", if enabled { "true" } else { "false" })],
    )
    .map(strip_ok)
}

fn tool_definitions() -> Value {
    json!({
        "tools": [
            {
                "name": "list_annotations",
                "description": "List unresolved review annotations for the current worktree — both code annotations (kind: \"code\", anchored to file/line) and browser annotations (kind: \"browser\", anchored to a URL + CSS selector in the Impala browser pane; fetch their screenshot with get_browser_annotation_screenshot). Defaults to the current working directory; pass repo_path to query a different worktree.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_path": {
                            "type": "string",
                            "description": "Worktree path to query. Defaults to the current working directory."
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
                "description": "Mark an annotation (code or browser) as resolved.",
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
                "name": "get_browser_annotation_screenshot",
                "description": "Fetch the stored screenshot crop of a browser annotation (the element the reviewer picked), as an image.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "The browser annotation ID"
                        }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "browser_screenshot",
                "description": "Capture a PNG screenshot of this worktree's browser pane in Impala — see exactly what the rendered page looks like. Use this to visually verify frontend changes yourself instead of asking the user to check, and prefer it over curl or headless browsers. Requires the Impala app to be running with a browser tab open for the worktree.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        }
                    }
                }
            },
            {
                "name": "browser_console",
                "description": "Read console output (console.*, window errors, unhandled rejections) captured from the page in this worktree's Impala browser pane. Use this when diagnosing why a page is blank or misbehaving. Pass clear=true to drain the buffer after reading; logs reset on navigation.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        },
                        "clear": {
                            "type": "boolean",
                            "description": "Clear the captured logs after reading (default false)"
                        }
                    }
                }
            },
            {
                "name": "browser_page_info",
                "description": "Get the current URL, title, document readyState, and viewport size (CSS px) of this worktree's Impala browser pane. Cheap first call before navigating or screenshotting — tells you whether a pane is open and what it's showing. The viewport size is also how you scale screenshot pixel coordinates for browser_click_at.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        }
                    }
                }
            },
            {
                "name": "browser_navigate",
                "description": "Navigate this worktree's Impala browser pane to a URL (e.g. the dev server). If no browser tab exists yet one is created (response has created: true); its webview loads when the pane is visible in Impala, so an immediate screenshot after created: true may fail until the user can see the tab.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        },
                        "url": {
                            "type": "string",
                            "description": "The URL to open"
                        }
                    },
                    "required": ["url"]
                }
            },
            {
                "name": "browser_click",
                "description": "Click an element in this worktree's Impala browser pane by CSS selector (from a browser annotation, or found via browser_console/page inspection). Delivers real platform input — the page sees trusted events (isTrusted: true) with user activation, so clipboard access and native controls respond. A native OS dialog (e.g. a file picker) may open; you cannot drive those — tell the user. window.open to a new window stays blocked (the pane has no popup handling). A visible cursor glides to the target in the pane. Take a browser_screenshot afterwards to verify the result.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        },
                        "selector": {
                            "type": "string",
                            "description": "CSS selector of the element to click; the first match is used"
                        }
                    },
                    "required": ["selector"]
                }
            },
            {
                "name": "browser_type",
                "description": "Type into an input, textarea, or contenteditable in this worktree's Impala browser pane by CSS selector: a real click focuses the element, the current value is selected, and the text is typed as real keystrokes (trusted keydown/input events — frameworks and keystroke handlers register them). Replaces the whole current value — pass an empty string to clear. Newline characters press Return, which may submit the form. Falls back to a native value-setter if the element refuses focus. Take a browser_screenshot afterwards to verify.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        },
                        "selector": {
                            "type": "string",
                            "description": "CSS selector of the field to type into; the first match is used"
                        },
                        "text": {
                            "type": "string",
                            "description": "The text to set (replaces the current value; empty clears)"
                        }
                    },
                    "required": ["selector", "text"]
                }
            },
            {
                "name": "browser_click_at",
                "description": "Click at raw viewport coordinates in this worktree's Impala browser pane — for canvas, maps, or other targets with no usable CSS selector (otherwise prefer browser_click). Coordinates are CSS pixels with origin at the viewport's top-left. Screenshots are captured at the display's scale factor: divide screenshot pixel coordinates by (screenshot width / viewport width from browser_page_info) before passing them here. The click is real platform input, delivered with a visible cursor glide.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        },
                        "x": {
                            "type": "number",
                            "description": "X coordinate in CSS px from the viewport's left edge"
                        },
                        "y": {
                            "type": "number",
                            "description": "Y coordinate in CSS px from the viewport's top edge"
                        }
                    },
                    "required": ["x", "y"]
                }
            },
            {
                "name": "browser_scroll",
                "description": "Scroll this worktree's Impala browser pane with a real wheel event aimed at the viewport center. Positive dy scrolls down, negative up; dx scrolls horizontally (optional, default 0). Deltas are CSS pixels. Take a browser_screenshot afterwards to see the result.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        },
                        "dy": {
                            "type": "number",
                            "description": "Vertical scroll amount in CSS px (positive scrolls down)"
                        },
                        "dx": {
                            "type": "number",
                            "description": "Horizontal scroll amount in CSS px (positive scrolls right, default 0)"
                        }
                    },
                    "required": ["dy"]
                }
            },
            {
                "name": "open_agent_tab",
                "description": "Delegate work to a fresh agent thread in a new Impala Agent tab for this worktree. The caller pane is detected automatically. Set placement='right' or 'left' to open the tab in that neighboring split pane, or placement='current' for the caller's pane. With the default placement='auto', a caller in a secondary split pane opens locally; otherwise the tab opens in the main workspace strip. Use when the user says to investigate, implement, continue, or do something 'in a new thread', 'in another agent tab', or equivalent. Pass agent='claude' or agent='codex' when the user names a provider; omit it to use the worktree's configured agent. The new thread has no access to this conversation: turn references such as 'this issue' or 'this plan' into a self-contained prompt with the relevant paths, requirements, and context. After opening the tab, do not also perform the delegated task in the current thread unless the user explicitly asks you to.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        },
                        "prompt": {
                            "type": "string",
                            "description": "Self-contained task for the new agent thread"
                        },
                        "agent": {
                            "type": "string",
                            "enum": ["claude", "codex"],
                            "description": "Agent provider for this tab. Defaults to the worktree's configured agent."
                        },
                        "placement": {
                            "type": "string",
                            "enum": ["auto", "current", "left", "right"],
                            "description": "Where to open the tab relative to the calling agent pane. Defaults to auto."
                        }
                    },
                    "required": ["prompt"]
                }
            },
            {
                "name": "list_automations",
                "description": "List this project's scheduled automations in Impala (name, prompt, cron schedule, agent, enabled, next run) plus recent runs. Call before create_automation to avoid duplicates. Each automation run creates a fresh worktree, launches the agent with the stored prompt, and lands as a reviewable diff in Impala.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        }
                    }
                }
            },
            {
                "name": "create_automation",
                "description": "Create a scheduled automation in Impala for this project. Runs fire while the Impala app is open (a missed slot fires once on next launch); each run creates a fresh worktree and launches the agent with the prompt. Write the prompt to be self-contained and to save its output into files in the worktree — the diff is what the user reviews. Schedule is 5-field cron in local time (e.g. \"0 9 * * MON-FRI\").",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "worktree_path": {
                            "type": "string",
                            "description": "Worktree path. Defaults to the current working directory."
                        },
                        "name": {
                            "type": "string",
                            "description": "Short human name, e.g. \"Daily standup digest\""
                        },
                        "prompt": {
                            "type": "string",
                            "description": "The prompt each run starts the agent with. Self-contained; output written into worktree files."
                        },
                        "schedule": {
                            "type": "string",
                            "description": "5-field cron expression, local time (e.g. \"0 9 * * MON-FRI\")"
                        },
                        "agent": {
                            "type": "string",
                            "enum": ["claude", "codex"],
                            "description": "Agent to run. Defaults to this worktree's agent."
                        }
                    },
                    "required": ["name", "prompt", "schedule"]
                }
            },
            {
                "name": "update_automation",
                "description": "Edit an existing automation (get the id from list_automations). Pass only the fields to change — name, prompt, schedule, and/or agent; omitted fields keep their current value. Changing the schedule recomputes the next run from now.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "The automation id"
                        },
                        "name": {
                            "type": "string",
                            "description": "New name"
                        },
                        "prompt": {
                            "type": "string",
                            "description": "New prompt each run starts the agent with. Self-contained; output written into worktree files."
                        },
                        "schedule": {
                            "type": "string",
                            "description": "New 5-field cron expression, local time (e.g. \"0 9 * * MON-FRI\")"
                        },
                        "agent": {
                            "type": "string",
                            "enum": ["claude", "codex"],
                            "description": "New agent to run"
                        }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "run_automation_now",
                "description": "Trigger one immediate run of an automation (get the id from list_automations). Creates a real worktree and launches the agent — tell the user before doing this. Does not change the automation's schedule.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "The automation id"
                        }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "set_automation_enabled",
                "description": "Pause (enabled=false) or resume (enabled=true) an automation. Resuming schedules from now — occurrences missed while paused are skipped.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "The automation id"
                        },
                        "enabled": {
                            "type": "boolean",
                            "description": "false to pause, true to resume"
                        }
                    },
                    "required": ["id", "enabled"]
                }
            },
            {
                "name": "list_files_with_annotations",
                "description": "List files in the current worktree that have unresolved annotations, with counts. Defaults to the current working directory; pass repo_path to query a different worktree.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo_path": {
                            "type": "string",
                            "description": "Worktree path to query. Defaults to the current working directory."
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

            // Screenshot tools return MCP image content blocks, not JSON text.
            if tool_name == "browser_screenshot" || tool_name == "get_browser_annotation_screenshot"
            {
                let shot = if tool_name == "browser_screenshot" {
                    tool_browser_screenshot(&tool_args)
                } else {
                    tool_browser_annotation_screenshot(conn, &tool_args)
                };
                return Some(match shot {
                    Ok(b64) => make_response(
                        id,
                        json!({
                            "content": [
                                { "type": "image", "data": b64, "mimeType": "image/png" }
                            ]
                        }),
                    ),
                    Err(e) => make_response(id, make_tool_error(&e)),
                });
            }

            let result = match tool_name {
                "list_annotations" => tool_list_annotations(conn, &tool_args),
                "resolve_annotation" => tool_resolve_annotation(conn, &tool_args),
                "browser_console" => tool_browser_console(&tool_args),
                "browser_page_info" => tool_browser_page_info(&tool_args),
                "browser_navigate" => tool_browser_navigate(&tool_args),
                "browser_click" => tool_browser_click(&tool_args),
                "browser_click_at" => tool_browser_click_at(&tool_args),
                "browser_scroll" => tool_browser_scroll(&tool_args),
                "browser_type" => tool_browser_type(&tool_args),
                "open_agent_tab" => tool_open_agent_tab(&tool_args),
                "list_automations" => tool_list_automations(&tool_args),
                "create_automation" => tool_create_automation(&tool_args),
                "update_automation" => tool_update_automation(&tool_args),
                "run_automation_now" => tool_run_automation_now(&tool_args),
                "set_automation_enabled" => tool_set_automation_enabled(&tool_args),
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
    let _observability = observability::init();

    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        sentry::integrations::panic::panic_handler(info);
        tracing::error!(panic = %info, "mcp panicked");
        prev(info);
    }));

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
