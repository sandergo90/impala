use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tiny_http::{Server, Response};
use serde::Serialize;

pub struct AgentStatuses(pub Mutex<HashMap<String, String>>);

#[derive(Clone, Serialize)]
pub struct AgentStatusEvent {
    pub worktree_path: String,
    pub status: String,
}

pub fn hook_command_public(event_type: &str) -> String {
    hook_command(event_type)
}

/// The hook command for a specific event type.
/// Reads the hook port from ~/.impala/hook-port (written on each app start)
/// so that persistent PTY sessions always reach the current hook server,
/// even after an app restart changes the port.
fn hook_command(event_type: &str) -> String {
    format!(
        "[ -n \"$IMPALA_WORKTREE_PATH\" ] && IMPALA_HOOK_PORT=$(cat ~/.impala/hook-port 2>/dev/null) && [ -n \"$IMPALA_HOOK_PORT\" ] && curl -sG \"http://127.0.0.1:${{IMPALA_HOOK_PORT}}/hook\" --data-urlencode \"event_type={}\" --data-urlencode \"worktree_path=${{IMPALA_WORKTREE_PATH}}\" --connect-timeout 1 --max-time 2 2>/dev/null || true",
        event_type
    )
}

/// Start the hook HTTP server on a random port. Returns the port number.
/// The `statuses` map is updated with every event so the frontend can query
/// last-known agent status after a hard reload.
pub fn start(app_handle: AppHandle, statuses: Arc<AgentStatuses>) -> u16 {
    let server = Arc::new(
        Server::http("127.0.0.1:0").expect("Failed to start hook server")
    );
    let port = server.server_addr().to_ip().unwrap().port();

    // Write port to a well-known file so persistent PTY sessions can
    // discover the current hook server after an app restart.
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(".impala");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("hook-port"), port.to_string());
    }

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let url = request.url().to_string();

            let params: HashMap<String, String> = url
                .splitn(2, '?')
                .nth(1)
                .unwrap_or("")
                .split('&')
                .filter_map(|pair| {
                    let mut parts = pair.splitn(2, '=');
                    let key = parts.next()?;
                    let value = parts.next().unwrap_or("");
                    Some((
                        key.to_string(),
                        urlencoding::decode(value).unwrap_or_default().into_owned(),
                    ))
                })
                .collect();

            let event_type = params.get("event_type").map(|s| s.as_str()).unwrap_or("");
            let worktree_path = params.get("worktree_path").cloned().unwrap_or_default();

            let status = match event_type {
                "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" => "working",
                "Stop" => "idle",
                "PermissionRequest" => "permission",
                _ => "",
            };

            if !status.is_empty() && !worktree_path.is_empty() {
                if let Ok(mut map) = statuses.0.lock() {
                    map.insert(worktree_path.clone(), status.to_string());
                }
                let _ = app_handle.emit("agent-status", AgentStatusEvent {
                    worktree_path,
                    status: status.to_string(),
                });
            }

            let _ = request.respond(Response::from_string("ok"));
        }
    });

    port
}
