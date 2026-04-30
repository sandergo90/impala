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
    shell_path: Option<String>,
    shell_args: Option<Vec<String>>,
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
            shell_path,
            shell_args,
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

#[derive(serde::Serialize)]
pub struct ShellLaunch {
    pub shell_path: String,
    pub shell_args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[tauri::command]
pub fn prepare_shell_launch() -> ShellLaunch {
    use std::path::Path;

    let app_data = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("be.kodeus.impala");
    let zsh_dir = app_data.join("shell-wrappers/zsh");
    let bash_rcfile = app_data.join("shell-wrappers/bash/rcfile");

    let shell_path = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let shell_basename = Path::new(&shell_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("sh")
        .to_string();

    let mut env = HashMap::new();
    let shell_args = match shell_basename.as_str() {
        "zsh" => {
            let original = std::env::var("ZDOTDIR")
                .ok()
                .or_else(|| std::env::var("HOME").ok())
                .unwrap_or_default();
            env.insert("IMPALA_ORIG_ZDOTDIR".into(), original);
            env.insert("ZDOTDIR".into(), zsh_dir.to_string_lossy().into_owned());
            vec!["-l".into()]
        }
        "bash" => {
            if bash_rcfile.exists() {
                vec![
                    "--rcfile".into(),
                    bash_rcfile.to_string_lossy().into_owned(),
                    "-l".into(),
                ]
            } else {
                vec!["-l".into()]
            }
        }
        _ => vec!["-l".into()],
    };

    ShellLaunch {
        shell_path,
        shell_args,
        env,
    }
}
