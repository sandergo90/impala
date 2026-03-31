use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tiny_http::{Server, Response};
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct AgentStatusEvent {
    pub worktree_path: String,
    pub status: String,
}

/// Start the hook HTTP server on a random port. Returns the port number.
pub fn start(app_handle: AppHandle) -> u16 {
    let server = Arc::new(
        Server::http("127.0.0.1:0").expect("Failed to start hook server")
    );
    let port = server.server_addr().to_ip().unwrap().port();

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let url = request.url().to_string();

            let params: std::collections::HashMap<String, String> = url
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
                _ => "",
            };

            if !status.is_empty() && !worktree_path.is_empty() {
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
