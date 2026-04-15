use crate::daemon_client::DaemonState;
use impala_daemon_shared::wire::{Request, Response};
use std::collections::HashMap;

fn unwrap_or_err<T>(resp: Result<Response, String>, f: impl FnOnce(Response) -> Option<T>) -> Result<T, String> {
    let resp = resp?;
    if let Response::Error { message } = &resp {
        return Err(message.clone());
    }
    f(resp).ok_or_else(|| "unexpected daemon response".to_string())
}

#[tauri::command]
pub async fn pty_spawn(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    cwd: String,
    command: Option<Vec<String>>,
    env_vars: Option<HashMap<String, String>>,
) -> Result<bool, String> {
    let env: Vec<(String, String)> = env_vars
        .unwrap_or_default()
        .into_iter()
        .collect();
    let resp = state
        .client()?
        .request(Request::Spawn {
            session_id,
            cwd,
            command,
            env,
            cols: 80,
            rows: 24,
        })
        .await;
    unwrap_or_err(resp, |r| match r {
        Response::Spawned { already_existed, .. } => Some(!already_existed),
        _ => None,
    })
}

#[tauri::command]
pub async fn pty_get_buffer(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
) -> Result<String, String> {
    let resp = state
        .client()?
        .request(Request::GetBuffer { session_id })
        .await;
    unwrap_or_err(resp, |r| match r {
        Response::Buffer { data_b64, .. } => Some(data_b64),
        _ => None,
    })
}

#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let resp = state
        .client()?
        .request(Request::Write {
            session_id,
            data_b64: data,
        })
        .await;
    unwrap_or_err(resp, |r| matches!(r, Response::Wrote).then_some(()))
}

#[tauri::command]
pub async fn pty_resize(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let resp = state
        .client()?
        .request(Request::Resize {
            session_id,
            cols,
            rows,
        })
        .await;
    unwrap_or_err(resp, |r| matches!(r, Response::Resized).then_some(()))
}

#[tauri::command]
pub async fn pty_kill(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
) -> Result<(), String> {
    let client = state.client()?;
    let resp = client.request(Request::Kill { session_id: session_id.clone() }).await;
    client.forget_session(&session_id);
    unwrap_or_err(resp, |r| matches!(r, Response::Killed).then_some(()))
}

#[tauri::command]
pub async fn pty_is_alive(
    state: tauri::State<'_, DaemonState>,
    session_id: String,
) -> Result<bool, String> {
    let resp = state
        .client()?
        .request(Request::IsAlive { session_id })
        .await;
    unwrap_or_err(resp, |r| match r {
        Response::Alive { alive } => Some(alive),
        _ => None,
    })
}
