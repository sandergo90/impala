use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tiny_http::{Server, Response};
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct AgentStatusEvent {
    pub worktree_path: String,
    pub status: String,
}

const DIFFER_HOOK_MARKER: &str = "DIFFER_HOOK_PORT";

/// The hook command for a specific event type. Uses env vars set on the PTY process.
fn hook_command(event_type: &str) -> String {
    format!(
        "[ -n \"$DIFFER_HOOK_PORT\" ] && curl -sG \"http://127.0.0.1:${{DIFFER_HOOK_PORT}}/hook\" --data-urlencode \"event_type={}\" --data-urlencode \"worktree_path=${{DIFFER_WORKTREE_PATH}}\" --connect-timeout 1 --max-time 2 2>/dev/null || true",
        event_type
    )
}

/// Merge Differ hooks into ~/.claude/settings.json, preserving all other settings and hooks.
pub fn install_claude_hooks() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let settings_path = home.join(".claude").join("settings.json");

    // Read existing settings (or start with empty object)
    let mut settings: serde_json::Value = if settings_path.exists() {
        match std::fs::read_to_string(&settings_path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(_) => return, // Don't touch malformed settings
            },
            Err(_) => return,
        }
    } else {
        serde_json::json!({})
    };

    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    // Events we want hooks for, and whether they need a matcher
    let events = [
        ("UserPromptSubmit", false),
        ("Stop", false),
        ("PostToolUse", true),
    ];

    let mut changed = false;

    for (event_name, needs_matcher) in &events {
        let command = hook_command(event_name);

        let event_defs = hooks
            .as_object_mut()
            .unwrap()
            .entry(*event_name)
            .or_insert_with(|| serde_json::json!([]));

        let defs = match event_defs.as_array_mut() {
            Some(a) => a,
            None => continue,
        };

        // Remove any existing Differ-managed hooks (identified by marker)
        for def in defs.iter_mut() {
            if let Some(hook_list) = def.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                let before_len = hook_list.len();
                hook_list.retain(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| !c.contains(DIFFER_HOOK_MARKER))
                        .unwrap_or(true)
                });
                if hook_list.len() != before_len {
                    changed = true;
                }
            }
        }

        // Remove empty definitions left after cleanup
        let before_len = defs.len();
        defs.retain(|def| {
            def.get("hooks")
                .and_then(|h| h.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(true)
        });
        if defs.len() != before_len {
            changed = true;
        }

        // Check if our hook already exists in any definition
        let already_present = defs.iter().any(|def| {
            def.get("hooks")
                .and_then(|h| h.as_array())
                .map(|hooks| {
                    hooks.iter().any(|h| {
                        h.get("command")
                            .and_then(|c| c.as_str())
                            .map(|c| c.contains(DIFFER_HOOK_MARKER))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });

        if !already_present {
            let mut new_def = serde_json::json!({
                "hooks": [{ "type": "command", "command": command }]
            });
            if *needs_matcher {
                new_def["matcher"] = serde_json::json!("*");
            }
            defs.push(new_def);
            changed = true;
        }
    }

    if changed {
        if let Ok(content) = serde_json::to_string_pretty(&settings) {
            let _ = std::fs::write(&settings_path, content);
        }
    }
}

const DIFFER_REVIEW_SKILL: &str = r#"---
name: differ-review
description: Review and address code review annotations from Differ. Use when asked to review annotations, or when invoked as /differ-review.
allowed-tools: mcp__differ__list_annotations, mcp__differ__resolve_annotation, mcp__differ__list_files_with_annotations, Read, Edit, Write, Grep, Glob
argument-hint: "[annotation-id]"
---

Review and address code review annotations using the Differ MCP server tools.

ARGUMENTS: If an annotation ID is provided as an argument, address only that annotation. Otherwise, address all unresolved annotations.

## Steps

1. Call `mcp__differ__list_annotations` to fetch annotations (unresolved ones). If an ID argument was given, find that specific annotation.
2. For each annotation:
   a. Read the file at the annotated line to understand the context
   b. Address the feedback (make the requested change, fix the issue, etc.)
   c. Call `mcp__differ__resolve_annotation` with the annotation's `id` to mark it done
3. After addressing all annotations, briefly summarize what was changed.

## Notes

- Annotations have: `id`, `file_path`, `line_number`, `side` (left/right), `body` (the review comment), `resolved` (boolean)
- Focus on unresolved annotations (`resolved: false`)
- The `body` field contains the reviewer's feedback — read it carefully and address the specific concern
- Always resolve annotations after addressing them so the reviewer can see progress in Differ
"#;

/// Install the /differ-review skill to ~/.claude/skills/differ-review/SKILL.md
pub fn install_differ_review_skill() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };

    let skill_dir = home.join(".claude").join("skills").join("differ-review");
    if let Err(_) = std::fs::create_dir_all(&skill_dir) {
        return;
    }

    let skill_path = skill_dir.join("SKILL.md");
    let _ = std::fs::write(&skill_path, DIFFER_REVIEW_SKILL);
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
