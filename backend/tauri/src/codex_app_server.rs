use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tungstenite::{client, Message, WebSocket};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const DAEMON_SOCKET: &str = "app-server-control/app-server-control.sock";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlStatus {
    status: String,
    server_name: String,
    environment_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlClient {
    client_id: String,
    display_name: Option<String>,
    device_type: Option<String>,
    platform: Option<String>,
    os_version: Option<String>,
    device_model: Option<String>,
    app_version: Option<String>,
    last_seen_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlClients {
    data: Vec<RemoteControlClient>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlSnapshot {
    status: String,
    server_name: Option<String>,
    environment_id: Option<String>,
    clients: Vec<RemoteControlClient>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlPairing {
    pairing_code: String,
    manual_pairing_code: Option<String>,
    environment_id: String,
    expires_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RemoteControlPairingStatus {
    claimed: bool,
}

pub fn launch_environment(codex_home: &Path) -> Result<HashMap<String, String>, String> {
    let codex = codex_home.join("packages/standalone/current/codex");
    if !codex.is_file() {
        return Err(format!(
            "Codex Remote requires the managed standalone install at {}",
            codex.display()
        ));
    }
    let enabled = run_daemon_command(&codex, codex_home, "enable-remote-control")?;
    let started = run_daemon_command(&codex, codex_home, "start")?;
    environment_from_daemon_outputs(codex_home, &enabled, &started)
}

fn run_daemon_command(codex: &Path, codex_home: &Path, command: &str) -> Result<Vec<u8>, String> {
    let output = Command::new(codex)
        .args(["app-server", "daemon", command])
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("run Codex app-server daemon {command}: {error}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    Err(format!(
        "Codex app-server daemon {command} failed: {detail}"
    ))
}

fn environment_from_daemon_outputs(
    codex_home: &Path,
    enabled: &[u8],
    started: &[u8],
) -> Result<HashMap<String, String>, String> {
    let enabled: Value = serde_json::from_slice(enabled)
        .map_err(|error| format!("parse Codex enable-remote-control output: {error}"))?;
    if enabled.get("remoteControlEnabled").and_then(Value::as_bool) != Some(true) {
        return Err("Codex app-server did not enable Remote control".to_string());
    }
    validate_daemon_socket(codex_home, &enabled)?;
    let socket = validate_daemon_socket(
        codex_home,
        &serde_json::from_slice(started)
            .map_err(|error| format!("parse Codex daemon start output: {error}"))?,
    )?;
    Ok(HashMap::from([(
        "IMPALA_CODEX_APP_SERVER".to_string(),
        format!("unix://{}", socket.display()),
    )]))
}

fn validate_daemon_socket(codex_home: &Path, output: &Value) -> Result<PathBuf, String> {
    let socket = output
        .get("socketPath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "Codex app-server daemon output has no socketPath".to_string())?;
    let expected = codex_home.join(DAEMON_SOCKET);
    if socket != expected {
        return Err(format!(
            "Codex app-server returned unexpected socket {}",
            socket.display()
        ));
    }
    Ok(socket)
}

fn socket_path(remote: &str) -> Result<PathBuf, String> {
    let raw = remote
        .strip_prefix("unix://")
        .filter(|value| value.starts_with('/'))
        .ok_or_else(|| "Impala callbacks require an absolute unix:// app-server URL".to_string())?;
    Ok(PathBuf::from(raw))
}

pub fn is_managed_remote(remote: &str) -> bool {
    let Some(codex_home) = crate::agent_config::codex_home_path() else {
        return false;
    };
    is_managed_remote_in(remote, &codex_home)
}

fn is_managed_remote_in(remote: &str, codex_home: &Path) -> bool {
    let Ok(path) = socket_path(remote) else {
        return false;
    };
    path == codex_home.join(DAEMON_SOCKET)
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

fn managed_remote(codex_home: &Path) -> String {
    format!("unix://{}", codex_home.join(DAEMON_SOCKET).display())
}

pub fn remote_snapshot(codex_home: &Path) -> Result<RemoteControlSnapshot, String> {
    let remote = managed_remote(codex_home);
    if !socket_path(&remote)?.exists() {
        return Ok(RemoteControlSnapshot {
            status: "offline".to_string(),
            server_name: None,
            environment_id: None,
            clients: Vec::new(),
        });
    }

    let mut socket = initialize_client(&remote)?;
    let status: RemoteControlStatus = serde_json::from_value(request(
        &mut socket,
        2,
        "remoteControl/status/read",
        json!({}),
    )?)
    .map_err(|error| format!("parse Codex Remote status: {error}"))?;
    let clients = match status.environment_id.as_deref() {
        Some(environment_id) => {
            let response: RemoteControlClients = serde_json::from_value(request(
                &mut socket,
                3,
                "remoteControl/client/list",
                json!({
                    "environmentId": environment_id,
                    "limit": 100,
                    "order": "desc",
                }),
            )?)
            .map_err(|error| format!("parse Codex Remote clients: {error}"))?;
            response.data
        }
        None => Vec::new(),
    };
    let _ = socket.close(None);

    Ok(RemoteControlSnapshot {
        status: status.status,
        server_name: Some(status.server_name),
        environment_id: status.environment_id,
        clients,
    })
}

pub fn start_pairing(codex_home: &Path) -> Result<RemoteControlPairing, String> {
    launch_environment(codex_home)?;
    let mut socket = initialize_client(&managed_remote(codex_home))?;
    let pairing = serde_json::from_value(request(
        &mut socket,
        2,
        "remoteControl/pairing/start",
        json!({ "manualCode": true }),
    )?)
    .map_err(|error| format!("parse Codex Remote pairing: {error}"))?;
    let _ = socket.close(None);
    Ok(pairing)
}

pub fn pairing_status(
    codex_home: &Path,
    pairing_code: &str,
) -> Result<RemoteControlPairingStatus, String> {
    if pairing_code.trim().is_empty() {
        return Err("Codex Remote pairing code is empty".to_string());
    }
    let mut socket = initialize_client(&managed_remote(codex_home))?;
    let status = serde_json::from_value(request(
        &mut socket,
        2,
        "remoteControl/pairing/status",
        json!({ "pairingCode": pairing_code }),
    )?)
    .map_err(|error| format!("parse Codex Remote pairing status: {error}"))?;
    let _ = socket.close(None);
    Ok(status)
}

pub fn revoke_client(
    codex_home: &Path,
    environment_id: &str,
    client_id: &str,
) -> Result<(), String> {
    if environment_id.trim().is_empty() || client_id.trim().is_empty() {
        return Err("Codex Remote environment and client are required".to_string());
    }
    let mut socket = initialize_client(&managed_remote(codex_home))?;
    request(
        &mut socket,
        2,
        "remoteControl/client/revoke",
        json!({
            "environmentId": environment_id,
            "clientId": client_id,
        }),
    )?;
    let _ = socket.close(None);
    Ok(())
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
    fn uses_the_shared_remote_enabled_daemon_socket() {
        let codex_home = Path::new("/Users/test/.codex");
        let socket = codex_home.join(DAEMON_SOCKET);
        let enabled = format!(
            r#"{{"remoteControlEnabled":true,"socketPath":"{}"}}"#,
            socket.display()
        );
        let started = format!(
            r#"{{"status":"started","socketPath":"{}"}}"#,
            socket.display()
        );

        let env =
            environment_from_daemon_outputs(codex_home, enabled.as_bytes(), started.as_bytes())
                .unwrap();

        assert_eq!(
            env["IMPALA_CODEX_APP_SERVER"],
            "unix:///Users/test/.codex/app-server-control/app-server-control.sock"
        );
        assert!(environment_from_daemon_outputs(
            codex_home,
            br#"{"remoteControlEnabled":false,"socketPath":"/Users/test/.codex/app-server-control/app-server-control.sock"}"#,
            started.as_bytes(),
        )
        .is_err());
        assert!(is_managed_remote_in(
            "unix:///Users/test/.codex/app-server-control/app-server-control.sock",
            codex_home,
        ));
        assert!(!is_managed_remote_in(
            "unix:///tmp/app-server-control/app-server-control.sock",
            codex_home,
        ));
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
    fn rejects_empty_remote_management_inputs_before_connecting() {
        let codex_home = Path::new("/Users/test/.codex");

        assert_eq!(
            pairing_status(codex_home, " ").unwrap_err(),
            "Codex Remote pairing code is empty"
        );
        assert_eq!(
            revoke_client(codex_home, "environment-1", "").unwrap_err(),
            "Codex Remote environment and client are required"
        );
    }

    #[test]
    #[ignore = "requires a running Impala Codex app-server"]
    fn reads_remote_status_and_devices_from_a_live_server() {
        let codex_home = std::env::var("IMPALA_TEST_CODEX_HOME").unwrap();
        let snapshot = remote_snapshot(Path::new(&codex_home)).unwrap();

        assert_eq!(snapshot.status, "connected");
        assert!(snapshot.environment_id.is_some());
        assert!(!snapshot.clients.is_empty());
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
