use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::os::unix::{fs::OpenOptionsExt, fs::PermissionsExt};
use std::path::PathBuf;
use std::time::Duration;
use tungstenite::{client, Message, WebSocket};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub fn launch_environment(pty_session_id: &str) -> Result<HashMap<String, String>, String> {
    let directory = dirs::home_dir()
        .ok_or_else(|| "could not determine home directory".to_string())?
        .join(".impala")
        .join("codex-app-servers");
    launch_environment_in(&directory, pty_session_id)
}

fn launch_environment_in(
    directory: &std::path::Path,
    pty_session_id: &str,
) -> Result<HashMap<String, String>, String> {
    if pty_session_id.trim().is_empty() {
        return Err("PTY session id is empty".to_string());
    }
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("create {}: {error}", directory.display()))?;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("secure {}: {error}", directory.display()))?;
    let id: String = Sha256::digest(pty_session_id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let socket = directory.join(format!("{}.sock", &id[..24]));
    let log = directory.join(format!("{}.log", &id[..24]));
    // Ponytail: one diagnostic log is retained per stable PTY id. Prune these
    // with PTY history if Impala later keeps an unbounded session archive.
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log)
        .map_err(|error| format!("create {}: {error}", log.display()))?;
    std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("secure {}: {error}", log.display()))?;
    Ok(HashMap::from([
        (
            "IMPALA_CODEX_APP_SERVER".to_string(),
            format!("unix://{}", socket.display()),
        ),
        (
            "IMPALA_CODEX_APP_SERVER_LOG".to_string(),
            log.to_string_lossy().into_owned(),
        ),
    ]))
}

fn socket_path(remote: &str) -> Result<PathBuf, String> {
    let raw = remote
        .strip_prefix("unix://")
        .filter(|value| value.starts_with('/'))
        .ok_or_else(|| "Impala callbacks require an absolute unix:// app-server URL".to_string())?;
    Ok(PathBuf::from(raw))
}

pub fn is_managed_remote(remote: &str) -> bool {
    let Ok(path) = socket_path(remote) else {
        return false;
    };
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    path.parent() == Some(home.join(".impala").join("codex-app-servers").as_path())
        && path.extension().and_then(|value| value.to_str()) == Some("sock")
}

fn connect(remote: &str) -> Result<WebSocket<UnixStream>, String> {
    let path = socket_path(remote)?;
    let stream = UnixStream::connect(&path)
        .map_err(|error| format!("connect to {}: {error}", path.display()))?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| format!("set Codex app-server read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| format!("set Codex app-server write timeout: {error}"))?;
    client("ws://localhost/rpc", stream)
        .map(|(socket, _)| socket)
        .map_err(|error| format!("upgrade Codex app-server socket: {error}"))
}

fn send_json(socket: &mut WebSocket<UnixStream>, value: Value) -> Result<(), String> {
    socket
        .send(Message::Text(value.to_string().into()))
        .map_err(|error| format!("send Codex app-server request: {error}"))
}

fn request(
    socket: &mut WebSocket<UnixStream>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    send_json(
        socket,
        json!({
            "id": id,
            "method": method,
            "params": params,
        }),
    )?;

    loop {
        let message = socket
            .read()
            .map_err(|error| format!("read Codex app-server response: {error}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        let value: Value = serde_json::from_str(text.as_str())
            .map_err(|error| format!("parse Codex app-server response: {error}"))?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown app-server error");
            return Err(message.to_string());
        }
        return value
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex app-server response has no result".to_string());
    }
}

fn initialize_client(remote: &str) -> Result<WebSocket<UnixStream>, String> {
    let mut socket = connect(remote)?;
    request(
        &mut socket,
        1,
        "initialize",
        json!({
            "clientInfo": {
                "name": "impala",
                "title": "Impala",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": {
                "experimentalApi": true,
            },
        }),
    )?;
    send_json(&mut socket, json!({ "method": "initialized" }))?;
    Ok(socket)
}

pub fn start_turn(
    remote: &str,
    thread_id: &str,
    client_user_message_id: &str,
    prompt: &str,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("Codex thread id is empty".to_string());
    }
    if prompt.trim().is_empty() {
        return Err("Codex callback prompt is empty".to_string());
    }

    let mut socket = initialize_client(remote)?;
    request(
        &mut socket,
        2,
        "turn/start",
        json!({
            "threadId": thread_id,
            "clientUserMessageId": client_user_message_id,
            "input": [{ "type": "text", "text": prompt }],
        }),
    )?;

    let _ = socket.close(None);
    let _ = socket.get_ref().shutdown(Shutdown::Both);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_one_private_socket_per_pty_session() {
        let directory = tempfile::tempdir().unwrap();
        let first = launch_environment_in(directory.path(), "pty-pane-1").unwrap();
        let again = launch_environment_in(directory.path(), "pty-pane-1").unwrap();
        let second = launch_environment_in(directory.path(), "pty-pane-2").unwrap();
        assert_eq!(first, again);
        assert_ne!(
            first["IMPALA_CODEX_APP_SERVER"],
            second["IMPALA_CODEX_APP_SERVER"]
        );
        assert!(socket_path(&first["IMPALA_CODEX_APP_SERVER"])
            .unwrap()
            .is_absolute());
        assert_eq!(
            std::fs::metadata(&first["IMPALA_CODEX_APP_SERVER_LOG"])
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let managed = format!(
            "unix://{}",
            dirs::home_dir()
                .unwrap()
                .join(".impala/codex-app-servers/managed.sock")
                .display()
        );
        assert!(is_managed_remote(&managed));
        assert!(!is_managed_remote("unix:///tmp/untrusted.sock"));
    }

    #[test]
    fn rejects_empty_turn_inputs_before_connecting() {
        assert_eq!(
            start_turn("unix:///tmp/codex.sock", "", "completion-1", "continue").unwrap_err(),
            "Codex thread id is empty"
        );
        assert_eq!(
            start_turn("unix:///tmp/codex.sock", "thread-1", "completion-1", " ").unwrap_err(),
            "Codex callback prompt is empty"
        );
    }

    #[test]
    #[ignore = "requires a running Impala Codex app-server"]
    fn addresses_a_thread_through_a_live_server() {
        let remote = std::env::var("IMPALA_TEST_CODEX_APP_SERVER").unwrap();
        let mut creator = connect(&remote).unwrap();
        request(
            &mut creator,
            1,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "impala-test",
                    "title": "Impala test",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        )
        .unwrap();
        send_json(&mut creator, json!({ "method": "initialized" })).unwrap();
        let created = request(
            &mut creator,
            2,
            "thread/start",
            json!({ "cwd": std::env::current_dir().unwrap() }),
        )
        .unwrap();
        let thread_id = created["thread"]["id"].as_str().unwrap().to_string();
        creator.close(None).unwrap();

        let mut socket = initialize_client(&remote).unwrap();
        request(
            &mut socket,
            2,
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": false }),
        )
        .unwrap();
        socket.close(None).unwrap();
    }
}
