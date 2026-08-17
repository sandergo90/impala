use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCodexPane {
    pub worktree_path: String,
    pub pane_id: String,
    pub thread_id: String,
    pub transport: String,
    pub settings: Value,
    pub current_turn_id: Option<String>,
    pub state: String,
    pub initial_prompt_sent: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePaneOpen {
    pub worktree_path: String,
    pub pane_id: String,
    pub settings: Value,
    pub initial_prompt: Option<String>,
}

const COLS: &str = "worktree_path, pane_id, thread_id, transport, settings_json, current_turn_id, state, initial_prompt_sent, created_at, updated_at";

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_codex_panes (
            worktree_path TEXT NOT NULL,
            pane_id TEXT NOT NULL,
            thread_id TEXT NOT NULL UNIQUE,
            transport TEXT NOT NULL CHECK (transport IN ('native', 'terminal')),
            settings_json TEXT NOT NULL,
            current_turn_id TEXT,
            state TEXT NOT NULL DEFAULT 'idle',
            initial_prompt_sent INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (worktree_path, pane_id)
        );
        CREATE INDEX IF NOT EXISTS idx_native_codex_panes_recovery ON native_codex_panes(transport, state);",
    ).map_err(|error| format!("initialize native Codex panes: {error}"))
    .and_then(|_| { let _ = conn.execute("ALTER TABLE native_codex_panes ADD COLUMN initial_prompt_sent INTEGER NOT NULL DEFAULT 0", []); Ok(()) })
}

pub(crate) fn apply_native_codex_notification(app: &AppHandle, envelope: &Value) {
    let Some(method) = envelope.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = envelope.get("params").unwrap_or(&Value::Null);
    let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
        return;
    };
    let (turn_id, state) = match method {
        "turn/started" => (
            params
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str),
            Some("working"),
        ),
        "turn/completed" => (None, Some("idle")),
        "turn/failed" => (None, Some("failed")),
        "turn/interrupted" => (None, Some("interrupted")),
        _ => return,
    };
    let db = app.state::<crate::DbState>();
    if let Ok(conn) = db.0.lock() {
        let _ = conn.execute(
            "UPDATE native_codex_panes SET current_turn_id = ?2, state = ?3, updated_at = CURRENT_TIMESTAMP WHERE thread_id = ?1 AND transport = 'native'",
            params![thread_id, turn_id, state],
        );
    }
    let _ = app.emit(
        "native-codex-pane-changed",
        json!({ "threadId": thread_id }),
    );
}

fn validate_input(worktree_path: &str, pane_id: &str) -> Result<(), String> {
    if worktree_path.trim().is_empty() || pane_id.trim().is_empty() {
        return Err("native Codex pane worktree and pane id are required".to_string());
    }
    if !std::path::Path::new(worktree_path).is_dir() {
        return Err("native Codex pane worktree does not exist".to_string());
    }
    Ok(())
}

fn validate_native_turn_input(input: &Value) -> Result<(), String> {
    let items = input
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| "native Codex input is required".to_string())?;
    for item in items {
        let item = item
            .as_object()
            .ok_or_else(|| "native Codex input item must be an object".to_string())?;
        match item.get("type").and_then(Value::as_str) {
            Some("text") if item.len() == 2 => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                if text.trim().is_empty() {
                    return Err("native Codex text input cannot be blank".to_string());
                }
            }
            Some("localImage") if item.len() == 2 => {
                let path = item.get("path").and_then(Value::as_str)
                    .ok_or_else(|| "native Codex local image path is required".to_string())?;
                let path = std::path::Path::new(path);
                if !path.is_absolute() || !path.is_file() {
                    return Err("native Codex local image path must be an existing absolute file".to_string());
                }
            }
            _ => return Err("native Codex input supports only text and local images".to_string()),
        }
    }
    Ok(())
}

fn row_to_pane(row: &rusqlite::Row<'_>) -> rusqlite::Result<NativeCodexPane> {
    let settings_json: String = row.get(4)?;
    Ok(NativeCodexPane {
        worktree_path: row.get(0)?,
        pane_id: row.get(1)?,
        thread_id: row.get(2)?,
        transport: row.get(3)?,
        settings: serde_json::from_str(&settings_json).unwrap_or(Value::Null),
        current_turn_id: row.get(5)?,
        state: row.get(6)?,
        initial_prompt_sent: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn find_pane(
    conn: &Connection,
    worktree_path: &str,
    pane_id: &str,
) -> Result<Option<NativeCodexPane>, String> {
    conn.query_row(
        &format!("SELECT {COLS} FROM native_codex_panes WHERE worktree_path = ?1 AND pane_id = ?2"),
        params![worktree_path, pane_id],
        row_to_pane,
    )
    .optional()
    .map_err(|error| format!("read native Codex pane: {error}"))
}

fn native_thread_id(value: &Value) -> Option<&str> {
    value
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .or_else(|| value.get("threadId"))
        .and_then(Value::as_str)
}

fn native_turn_id(value: &Value) -> Option<&str> {
    value
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .or_else(|| value.get("turnId"))
        .and_then(Value::as_str)
}

fn owned_pane(
    conn: &Connection,
    worktree_path: &str,
    pane_id: &str,
) -> Result<NativeCodexPane, String> {
    find_pane(conn, worktree_path, pane_id)?
        .filter(|pane| pane.transport == "native")
        .ok_or_else(|| "native Codex pane is not owned by Impala".to_string())
}

fn start_initial_prompt(
    conn: &Connection,
    state: &crate::codex_app_server::CodexAppServerState,
    pane: &NativeCodexPane,
    prompt: Option<&str>,
) -> Result<(), String> {
    let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) else { return Ok(()) };
    if pane.initial_prompt_sent { return Ok(()); }
    let mut params = json!({ "input": [{ "type": "text", "text": prompt }] });
    for key in ["model", "serviceTier", "effort"] {
        if let Some(value) = pane.settings.get(key) {
            params[key] = value.clone();
        }
    }
    let result = state.turn_start(&pane.thread_id, params)?;
    let turn_id = native_turn_id(&result).ok_or_else(|| "Codex initial turn returned no turn id".to_string())?;
    let changed = conn.execute(
        "UPDATE native_codex_panes SET initial_prompt_sent = 1, current_turn_id = ?3, state = 'working', updated_at = CURRENT_TIMESTAMP WHERE worktree_path = ?1 AND pane_id = ?2 AND initial_prompt_sent = 0 AND transport = 'native'",
        params![pane.worktree_path, pane.pane_id, turn_id],
    ).map_err(|error| format!("persist native Codex initial prompt: {error}"))?;
    if changed != 1 { return Err("native Codex initial prompt ownership lost".to_string()); }
    Ok(())
}

fn replace_fork_owner(conn: &Connection, pane: &NativeCodexPane, thread_id: &str) -> Result<(), String> {
    let changed = conn.execute("UPDATE native_codex_panes SET thread_id = ?3, current_turn_id = NULL, state = 'idle', updated_at = CURRENT_TIMESTAMP WHERE worktree_path = ?1 AND pane_id = ?2 AND thread_id = ?4 AND transport = 'native'", params![pane.worktree_path, pane.pane_id, thread_id, pane.thread_id]).map_err(|error| format!("persist native Codex fork: {error}"))?;
    if changed == 1 { Ok(()) } else { Err("native Codex pane ownership lost while forking".to_string()) }
}

fn mark_terminal_handoff(conn: &Connection, pane: &NativeCodexPane) -> Result<(), String> {
    let changed = conn.execute(
        "UPDATE native_codex_panes SET transport = 'terminal', current_turn_id = NULL, state = 'terminal', updated_at = CURRENT_TIMESTAMP WHERE worktree_path = ?1 AND pane_id = ?2 AND thread_id = ?3 AND transport = 'native'",
        params![pane.worktree_path, pane.pane_id, pane.thread_id],
    ).map_err(|error| format!("persist native Codex terminal handoff: {error}"))?;
    if changed == 1 {
        Ok(())
    } else {
        Err("native Codex pane ownership lost while handing off".to_string())
    }
}

#[tauri::command]
pub async fn open_native_codex_pane(
    app: AppHandle,
    db: tauri::State<'_, crate::DbState>,
    app_server: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
    input: NativePaneOpen,
) -> Result<NativeCodexPane, String> {
    validate_input(&input.worktree_path, &input.pane_id)?;
    if let Some(existing) = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        find_pane(&conn, &input.worktree_path, &input.pane_id)?
    } {
        if existing.transport != "native" {
            return Err("native Codex pane was handed off to terminal".to_string());
        }
        let state = app_server.inner().clone(); state.adopt_thread(&existing.thread_id)?;
        { let conn = db.0.lock().map_err(|error| format!("DB lock error: {error}"))?; start_initial_prompt(&conn, &state, &existing, input.initial_prompt.as_deref())?; }
        return { let conn = db.0.lock().map_err(|error| format!("DB lock error: {error}"))?; find_pane(&conn, &input.worktree_path, &input.pane_id)?.ok_or_else(|| "native Codex pane disappeared".to_string()) };
    }
    crate::automations::validate_native_codex_settings(&input.settings)?;
    let catalog_state = app_server.inner().clone();
    let catalog_settings = input.settings.clone();
    let supported = tokio::task::spawn_blocking(move || catalog_state.native_settings_supported(&catalog_settings))
        .await
        .map_err(|error| format!("native Codex pane catalog task join: {error}"))?;
    supported?;
    let state = app_server.inner().clone();
    let cwd = input.worktree_path.clone();
    let settings = input.settings.clone();
    let thread = tokio::task::spawn_blocking(move || {
        let mut params = json!({ "cwd": cwd });
        for (source, target) in [
            ("approvalPolicy", "approvalPolicy"),
            ("sandbox", "sandbox"),
            ("model", "model"),
            ("serviceTier", "serviceTier"),
        ] {
            if let Some(value) = settings.get(source) {
                params[target] = value.clone();
            }
        }
        state.thread_start(params)
    })
    .await
    .map_err(|error| format!("native Codex pane thread task join: {error}"))??;
    let thread_id = native_thread_id(&thread)
        .ok_or_else(|| "Codex thread/start returned no thread id".to_string())?
        .to_string();
    let settings_json = serde_json::to_string(&input.settings)
        .map_err(|error| format!("serialize native Codex pane settings: {error}"))?;
    let insert_error = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        conn.execute("INSERT INTO native_codex_panes (worktree_path, pane_id, thread_id, transport, settings_json) VALUES (?1, ?2, ?3, 'native', ?4)", params![input.worktree_path, input.pane_id, thread_id, settings_json]).err()
    };
    if let Some(error) = insert_error { let state = app_server.inner().clone(); let orphan = thread_id.clone(); let _ = tokio::task::spawn_blocking(move || state.thread_unsubscribe(&orphan).and_then(|_| state.disown_thread_after_unsubscribe(&orphan))).await; return Err(format!("persist native Codex pane ownership: {error}")); }
    let pane = { let conn = db.0.lock().map_err(|error| format!("DB lock error: {error}"))?; find_pane(&conn, &input.worktree_path, &input.pane_id)?.expect("inserted native Codex pane") };
    app_server.adopt_thread(&pane.thread_id)?;
    { let conn = db.0.lock().map_err(|error| format!("DB lock error: {error}"))?; start_initial_prompt(&conn, app_server.inner(), &pane, input.initial_prompt.as_deref())?; }
    let _ = app.emit("native-codex-pane-changed", &pane);
    Ok(pane)
}

#[tauri::command]
pub fn get_native_codex_pane(
    db: tauri::State<'_, crate::DbState>,
    worktree_path: String,
    pane_id: String,
) -> Result<Option<NativeCodexPane>, String> {
    let conn =
        db.0.lock()
            .map_err(|error| format!("DB lock error: {error}"))?;
    find_pane(&conn, &worktree_path, &pane_id)
}

#[tauri::command]
pub async fn read_native_codex_pane(
    db: tauri::State<'_, crate::DbState>,
    app_server: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
    worktree_path: String,
    pane_id: String,
) -> Result<Value, String> {
    let pane = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        owned_pane(&conn, &worktree_path, &pane_id)?
    };
    let state = app_server.inner().clone();
    let thread_id = pane.thread_id;
    tokio::task::spawn_blocking(move || state.thread_read(&thread_id))
        .await
        .map_err(|error| format!("native Codex pane read task join: {error}"))?
}

#[tauri::command]
pub async fn send_native_codex_pane_input(
    app: AppHandle,
    db: tauri::State<'_, crate::DbState>,
    app_server: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
    worktree_path: String,
    pane_id: String,
    input: Value,
) -> Result<Value, String> {
    let pane = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        owned_pane(&conn, &worktree_path, &pane_id)?
    };
    validate_native_turn_input(&input)?;
    let state = app_server.inner().clone();
    let thread_id = pane.thread_id.clone();
    let expected_turn_id = pane.current_turn_id.clone();
    let settings = pane.settings.clone();
    let result = tokio::task::spawn_blocking(move || match expected_turn_id {
        Some(turn_id) => state.turn_steer(&thread_id, &turn_id, input),
        None => {
            let mut params = json!({ "input": input });
            for key in ["model", "serviceTier", "effort"] {
                if let Some(value) = settings.get(key) {
                    params[key] = value.clone();
                }
            }
            state.turn_start(&thread_id, params)
        }
    })
    .await
    .map_err(|error| format!("native Codex pane input task join: {error}"))??;
    let turn_id = native_turn_id(&result).map(str::to_string);
    {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        let changed = conn.execute("UPDATE native_codex_panes SET current_turn_id = ?3, state = 'working', updated_at = CURRENT_TIMESTAMP WHERE worktree_path = ?1 AND pane_id = ?2 AND transport = 'native'", params![worktree_path, pane_id, turn_id])
        .map_err(|error| format!("persist native Codex turn: {error}"))?;
        if changed != 1 { return Err("native Codex pane ownership lost while starting turn".to_string()); }
    }
    let _ = app.emit(
        "native-codex-pane-changed",
        json!({ "worktreePath": worktree_path, "paneId": pane_id }),
    );
    Ok(result)
}

#[tauri::command]
pub async fn interrupt_native_codex_pane(
    app: AppHandle,
    db: tauri::State<'_, crate::DbState>,
    app_server: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
    worktree_path: String,
    pane_id: String,
) -> Result<(), String> {
    let pane = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        owned_pane(&conn, &worktree_path, &pane_id)?
    };
    let turn_id = pane
        .current_turn_id
        .ok_or_else(|| "native Codex pane has no active turn".to_string())?;
    let state = app_server.inner().clone();
    let thread_id = pane.thread_id;
    tokio::task::spawn_blocking(move || state.turn_interrupt(&thread_id, &turn_id))
        .await
        .map_err(|error| format!("native Codex pane interrupt task join: {error}"))??;
    let conn =
        db.0.lock()
            .map_err(|error| format!("DB lock error: {error}"))?;
    let changed = conn.execute("UPDATE native_codex_panes SET current_turn_id = NULL, state = 'interrupted', updated_at = CURRENT_TIMESTAMP WHERE worktree_path = ?1 AND pane_id = ?2 AND transport = 'native'", params![worktree_path, pane_id]).map_err(|error| format!("persist native Codex interrupt: {error}"))?;
    if changed != 1 { return Err("native Codex pane ownership lost while interrupting".to_string()); }
    let _ = app.emit(
        "native-codex-pane-changed",
        json!({ "worktreePath": worktree_path, "paneId": pane_id }),
    );
    Ok(())
}

#[tauri::command]
pub async fn resume_native_codex_pane(
    app_server: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
    db: tauri::State<'_, crate::DbState>,
    worktree_path: String,
    pane_id: String,
) -> Result<Value, String> {
    let pane = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        owned_pane(&conn, &worktree_path, &pane_id)?
    };
    let state = app_server.inner().clone();
    let thread_id = pane.thread_id;
    tokio::task::spawn_blocking(move || state.thread_resume(&thread_id))
        .await
        .map_err(|error| format!("native Codex pane resume task join: {error}"))?
}

#[tauri::command]
pub async fn fork_native_codex_pane(
    app: AppHandle,
    db: tauri::State<'_, crate::DbState>,
    app_server: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
    worktree_path: String,
    pane_id: String,
) -> Result<NativeCodexPane, String> {
    let pane = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        owned_pane(&conn, &worktree_path, &pane_id)?
    };
    let state = app_server.inner().clone();
    let old_thread_id = pane.thread_id.clone();
    let fork = tokio::task::spawn_blocking(move || state.thread_fork(&old_thread_id, json!({})))
        .await
        .map_err(|error| format!("native Codex pane fork task join: {error}"))??;
    let thread_id = native_thread_id(&fork)
        .ok_or_else(|| "Codex thread/fork returned no thread id".to_string())?
        .to_string();
    {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        replace_fork_owner(&conn, &pane, &thread_id)?;
    }
    app_server.adopt_thread(&thread_id)?;
    let cleanup = {
        let state = app_server.inner().clone();
        let old = pane.thread_id.clone();
        tokio::task::spawn_blocking(move || {
            state.thread_unsubscribe(&old).and_then(|_| state.disown_thread_after_unsubscribe(&old))
        })
        .await
        .map_err(|error| format!("native Codex fork cleanup task join: {error}"))?
    };
    if let Err(error) = cleanup {
        tracing::warn!(%error, old_thread_id = %pane.thread_id, new_thread_id = %thread_id, "forked native Codex pane could not release prior thread");
        let _ = app.emit("native-codex-pane-warning", json!({
            "threadId": thread_id,
            "message": format!("Forked thread but could not release prior thread: {error}"),
        }));
    }
    let pane = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        find_pane(&conn, &worktree_path, &pane_id)?.expect("forked pane exists")
    };
    let _ = app.emit("native-codex-pane-changed", &pane);
    Ok(pane)
}

#[tauri::command]
pub async fn archive_native_codex_pane(
    app: AppHandle,
    db: tauri::State<'_, crate::DbState>,
    app_server: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
    worktree_path: String,
    pane_id: String,
    archived: bool,
) -> Result<(), String> {
    let pane = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        owned_pane(&conn, &worktree_path, &pane_id)?
    };
    let state = app_server.inner().clone();
    let thread_id = pane.thread_id;
    tokio::task::spawn_blocking(move || {
        if archived {
            state.thread_archive(&thread_id)
        } else {
            state.thread_unarchive(&thread_id)
        }
    })
    .await
    .map_err(|error| format!("native Codex pane archive task join: {error}"))??;
    let conn =
        db.0.lock()
            .map_err(|error| format!("DB lock error: {error}"))?;
    let changed = conn.execute("UPDATE native_codex_panes SET state = ?3, updated_at = CURRENT_TIMESTAMP WHERE worktree_path = ?1 AND pane_id = ?2 AND transport = 'native'", params![worktree_path, pane_id, if archived { "archived" } else { "idle" }]).map_err(|error| format!("persist native Codex archive: {error}"))?;
    if changed != 1 { return Err("native Codex pane ownership lost while archiving".to_string()); }
    let _ = app.emit(
        "native-codex-pane-changed",
        json!({ "worktreePath": worktree_path, "paneId": pane_id }),
    );
    Ok(())
}

#[tauri::command]
pub async fn review_native_codex_pane(
    app_server: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
    db: tauri::State<'_, crate::DbState>,
    worktree_path: String,
    pane_id: String,
) -> Result<Value, String> {
    let pane = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        owned_pane(&conn, &worktree_path, &pane_id)?
    };
    let state = app_server.inner().clone();
    let thread_id = pane.thread_id;
    tokio::task::spawn_blocking(move || {
        state.review_start(&thread_id, json!({ "type": "uncommittedChanges" }))
    })
    .await
    .map_err(|error| format!("native Codex review task join: {error}"))?
}

/// The caller replaces the pane only after this returns. A failed unsubscribe
/// leaves both the durable native row and the native UI intact.
#[tauri::command]
pub async fn handoff_native_codex_pane_to_terminal(
    app: AppHandle,
    db: tauri::State<'_, crate::DbState>,
    app_server: tauri::State<'_, crate::codex_app_server::CodexAppServerState>,
    worktree_path: String,
    pane_id: String,
) -> Result<String, String> {
    let pane = {
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        owned_pane(&conn, &worktree_path, &pane_id)?
    };
    let state = app_server.inner().clone();
    let thread_id = pane.thread_id.clone();
    tokio::task::spawn_blocking(move || state.thread_unsubscribe(&thread_id))
        .await
        .map_err(|error| format!("native Codex terminal handoff task join: {error}"))??;
    let handoff = (|| {
        let conn = db.0.lock().map_err(|error| format!("DB lock error: {error}"))?;
        mark_terminal_handoff(&conn, &pane)
    })();
    if let Err(error) = handoff {
        let state = app_server.inner().clone();
        let thread_id = pane.thread_id.clone();
        let restore = tokio::task::spawn_blocking(move || state.thread_resume(&thread_id)).await;
        return Err(match restore {
            Ok(Ok(_)) => error,
            Ok(Err(restore_error)) => format!("{error}; could not restore native subscription: {restore_error}"),
            Err(join_error) => format!("{error}; native subscription restore task failed: {join_error}"),
        });
    }
    if let Err(error) = app_server.disown_thread_after_unsubscribe(&pane.thread_id) {
        tracing::warn!(%error, thread_id = %pane.thread_id, "native Codex terminal handoff persisted before local disown");
        let _ = app.emit("native-codex-pane-warning", json!({
            "threadId": pane.thread_id,
            "message": format!("Terminal handoff completed; local cleanup will retry on restart: {error}"),
        }));
    }
    let _ = app.emit(
        "native-codex-pane-changed",
        json!({ "worktreePath": worktree_path, "paneId": pane_id }),
    );
    Ok(pane.thread_id)
}

/// Recovery deliberately queries only native records: terminal handoffs are
/// durable ownership boundaries and must never be subscribed again.
pub(crate) fn recover_native_codex_panes(app: &AppHandle) -> Result<(), String> {
    let panes = {
        let db = app.state::<crate::DbState>();
        let conn =
            db.0.lock()
                .map_err(|error| format!("DB lock error: {error}"))?;
        let mut statement = conn.prepare(&format!("SELECT {COLS} FROM native_codex_panes WHERE transport = 'native' AND state != 'archived'")) .map_err(|error| format!("prepare native Codex pane recovery: {error}"))?;
        let rows = statement
            .query_map([], row_to_pane)
            .map_err(|error| format!("query native Codex pane recovery: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read native Codex pane recovery: {error}"))?
    };
    let state = app.state::<crate::codex_app_server::CodexAppServerState>();
    for pane in panes {
        state.adopt_thread(&pane.thread_id)?;
        let _ = state.thread_resume(&pane.thread_id);
        let _ = state.thread_read(&pane.thread_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn
    }
    #[test]
    fn ownership_is_unique_and_terminal_handoffs_are_excluded_from_recovery() {
        let conn = db();
        conn.execute("INSERT INTO native_codex_panes (worktree_path,pane_id,thread_id,transport,settings_json) VALUES ('/work','tab-agent','thread-1','native','{}')", []).unwrap();
        assert!(conn.execute("INSERT INTO native_codex_panes (worktree_path,pane_id,thread_id,transport,settings_json) VALUES ('/work','tab-agent','thread-2','native','{}')", []).is_err());
        conn.execute(
            "UPDATE native_codex_panes SET transport = 'terminal' WHERE thread_id = 'thread-1'",
            [],
        )
        .unwrap();
        let count: i64 = conn.query_row("SELECT count(*) FROM native_codex_panes WHERE transport = 'native' AND state != 'archived'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }
    #[test]
    fn archive_and_fork_replace_one_durable_owner() {
        let conn = db();
        conn.execute("INSERT INTO native_codex_panes (worktree_path,pane_id,thread_id,transport,settings_json,state) VALUES ('/work','tab-agent','thread-1','native','{}','idle')", []).unwrap();
        let pane = find_pane(&conn, "/work", "tab-agent").unwrap().unwrap();
        replace_fork_owner(&conn, &pane, "thread-2").unwrap();
        assert!(replace_fork_owner(&conn, &pane, "thread-3").is_err(), "stale owner cannot replace the durable fork");
        conn.execute("UPDATE native_codex_panes SET state = 'archived' WHERE worktree_path = '/work' AND pane_id = 'tab-agent'", []).unwrap();
        let pane = find_pane(&conn, "/work", "tab-agent").unwrap().unwrap();
        assert_eq!(pane.thread_id, "thread-2");
        assert_eq!(pane.state, "archived");
    }
    #[test]
    fn durable_handoff_rejects_a_stale_owner_and_excludes_terminal_recovery() {
        let conn = db();
        conn.execute("INSERT INTO native_codex_panes (worktree_path,pane_id,thread_id,transport,settings_json,state) VALUES ('/work','tab-agent','thread-1','native','{}','idle')", []).unwrap();
        let pane = find_pane(&conn, "/work", "tab-agent").unwrap().unwrap();
        mark_terminal_handoff(&conn, &pane).unwrap();
        assert!(mark_terminal_handoff(&conn, &pane).is_err());
        let pane = find_pane(&conn, "/work", "tab-agent").unwrap().unwrap();
        assert_eq!(pane.transport, "terminal");
        let recovery_count: i64 = conn.query_row(
            "SELECT count(*) FROM native_codex_panes WHERE transport = 'native' AND state != 'archived'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(recovery_count, 0);
    }
    #[test]
    fn native_turn_input_accepts_only_nonblank_text_and_existing_local_images() {
        assert!(validate_native_turn_input(&json!([
            { "type": "text", "text": "hello" },
            { "type": "localImage", "path": concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml") },
        ])).is_ok());
        for input in [
            json!([]),
            json!([{ "type": "text", "text": "  " }]),
            json!([{ "type": "image", "url": "https://example.test/image.png" }]),
            json!([{ "type": "localImage", "path": "relative.png" }]),
            json!([{ "type": "localImage", "path": "/missing.png" }]),
            json!([{ "type": "text", "text": "ok", "extra": true }]),
        ] {
            assert!(validate_native_turn_input(&input).is_err(), "{input}");
        }
    }
}
