use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tiny_http::{Response, Server};

pub struct AgentStatuses(pub Mutex<HashMap<String, String>>);

/// Per-worktree git tree sha captured when the user submits a prompt. Powers
/// the "Last turn" diff view. Persists in memory until the next prompt
/// replaces it; lost on app restart (acceptable — rebuilds on next turn).
pub struct LastTurnSnapshots(pub Mutex<HashMap<String, String>>);

/// One `caffeinate -i` child per worktree currently in "working" status.
/// Spawned on the working transition, killed on idle/permission. Exposed so
/// the app's RunEvent::Exit handler can drain it on shutdown; otherwise the
/// reparented caffeinate processes would linger.
pub struct Caffeinators(pub Mutex<HashMap<String, std::process::Child>>);

impl Caffeinators {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    /// Kill every caffeinate child and clear the map. Idempotent.
    pub fn kill_all(&self) {
        let Ok(mut map) = self.0.lock() else { return };
        for (_, mut child) in map.drain() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Clone, Serialize)]
pub struct AgentStatusEvent {
    pub worktree_path: String,
    pub status: String,
}

#[derive(Clone, Serialize)]
pub struct LastTurnSnapshotEvent {
    pub worktree_path: String,
}

pub fn hook_command_public(event_type: &str) -> String {
    hook_command(event_type)
}

/// The hook command for a specific event type.
/// Reads the hook port from ~/.impala/hook-port (written on each app start)
/// so that persistent PTY sessions always reach the current hook server,
/// even after an app restart changes the port. Stdout is fully suppressed:
/// Codex parses hook stdout as JSON and chokes on non-JSON bodies (Claude
/// Code ignores stdout entirely), so we make sure neither sees the HTTP
/// response body.
fn hook_command(event_type: &str) -> String {
    format!(
        "[ -n \"$IMPALA_WORKTREE_PATH\" ] && IMPALA_HOOK_PORT=$(cat ~/.impala/hook-port 2>/dev/null) && [ -n \"$IMPALA_HOOK_PORT\" ] && curl -sG \"http://127.0.0.1:${{IMPALA_HOOK_PORT}}/hook\" --data-urlencode \"event_type={}\" --data-urlencode \"worktree_path=${{IMPALA_WORKTREE_PATH}}\" --connect-timeout 1 --max-time 2 >/dev/null 2>&1 || true",
        event_type
    )
}

const IMPALA_REVIEW_SKILL: &str = r#"---
name: impala-review
description: Review and address code review annotations from Impala. Use when asked to review annotations, or when invoked as /impala-review.
allowed-tools: mcp__impala__list_annotations, mcp__impala__resolve_annotation, mcp__impala__list_files_with_annotations, mcp__impala__get_browser_annotation_screenshot, mcp__impala__browser_navigate, mcp__impala__browser_click, mcp__impala__browser_type, mcp__impala__browser_screenshot, mcp__impala__browser_console, mcp__impala__browser_page_info, Read, Edit, Write, Grep, Glob
argument-hint: "[annotation-id]"
---

Review and address review annotations from Impala using the MCP server tools. These are human-written review comments. They come in two kinds (the `kind` field): `code` annotations anchored to specific lines in the code, and `browser` annotations anchored to an element in the rendered app (URL + CSS selector + screenshot), created by the reviewer clicking an element in Impala's browser pane.

ARGUMENTS: If an annotation ID is provided as an argument, address only that annotation. Otherwise, address all unresolved annotations.

## Phase 1: Fetch and Plan

1. Call `mcp__impala__list_files_with_annotations` to get an overview of which files have annotations and how many.
2. Call `mcp__impala__list_annotations` to fetch unresolved annotations. If an ID argument was given, find that specific annotation.
3. If zero annotations, report "No unresolved review comments. Nothing to address." and stop.
4. Group annotations by file — you will work through them file by file so you only need to read each file once.

## Phase 2: Triage Each Annotation

For each unresolved annotation, read the file at the annotated line and evaluate the comment. Classify it as one of:

### ACTIONABLE
The reviewer requests a concrete change — a bug fix, a refactor, a naming improvement, using a different API, etc. The right action is clear from the comment.

Examples:
- "Use plain tailwind classes instead of this wrapper"
- "This should return an object, not void"
- "Never use plain buttons, always use from components"
- "Split this into multiple files"

### DISCUSSION
The reviewer raises a valid point, but the right approach is unclear or involves a tradeoff. The comment is a question, a suggestion to consider, or thinking out loud.

Examples:
- "Should these types be part of the store? It looks more component related"
- "Can't we use selectors or a better way for this?"
- "Do we need isMobile detection via a separate hook? Couldn't we just use tailwind for this?"

### ALREADY ADDRESSED
The concern has already been fixed in the current code, or is no longer relevant.

## Phase 3: Address Each Annotation

Work file by file. For each file, read it once, then process all annotations on that file before moving to the next.

After addressing each annotation, immediately call `mcp__impala__resolve_annotation` to mark it done.

**ACTIONABLE:** Fix the code, then resolve the annotation.

**DISCUSSION:** Before asking the user, explore the codebase to see if the answer is clear from context (existing patterns, conventions, usage elsewhere). If you can determine the right approach, treat it as ACTIONABLE instead.

If the question genuinely requires user input, present it well — ONE annotation per message:
1. Briefly explain why the reviewer's concern matters
2. List the realistic options with trade-offs
3. Give your recommended approach and why
4. Ask, then STOP and wait for their answer

Apply their decision, then resolve the annotation.

**ALREADY ADDRESSED:** Resolve the annotation immediately.

Keep fixes minimal and focused — don't refactor unrelated code. If a reviewer suggests a specific code change, prefer their version unless it introduces issues.

## Browser Annotations (kind: "browser")

These point at a rendered element, not a source line. For each one:

1. If `has_screenshot` is true, call `mcp__impala__get_browser_annotation_screenshot` with the annotation id to SEE the element the reviewer picked.
2. Locate the source: grep for the selector's distinctive parts (ids, class names, data-testids from `selector` and the `element` HTML snippet), and use the `url` path to identify the route/page component.
3. Make the change like any ACTIONABLE annotation.
4. **Verify visually**: call `mcp__impala__browser_navigate` to the annotation's `url` (the dev server must be running), then `mcp__impala__browser_screenshot` and confirm the change looks right. Check `mcp__impala__browser_console` if the page misbehaves.
5. Resolve the annotation.

## Phase 4: Verify

After all annotations are addressed, run the project's typecheck and lint to make sure nothing is broken. Fix any issues introduced by the changes.

## Phase 5: Summary

Report a structured summary:

```
## Review Annotations Summary

### Results
- Fixed: X annotations
- Already addressed: X
- Discussion resolved: X

### Changes
- <file>: <what was changed and why>
- <file>: <what was changed and why>
```

## Annotation Fields

- `id` — unique identifier, used for resolving
- `kind` — `code` or `browser`
- `body` — the reviewer's comment text
- `resolved` — boolean, only unresolved annotations are returned

Code annotations: `file_path`, `line_number`, and `side` (`left` = old/deleted code, `right` = new/added code).

Browser annotations: `url` (the page), `selector` (CSS path to the element), `element` (truncated outerHTML), `has_screenshot` (fetch it via `get_browser_annotation_screenshot`).

## Important Notes

- **Every annotation gets addressed** — no silent skips
- **Ask the user when uncertain** — don't guess on architectural or business logic questions
- **Verify before fixing** — read the code context, understand the intent, then act
- **Keep fixes minimal** — only change what the annotation asks for
- **Work file by file** — group annotations by file to avoid redundant file reads
"#;

const IMPALA_BROWSER_SKILL: &str = r#"---
name: impala-browser
description: Verify or diagnose the running app in Impala's built-in browser. Use when the user wants to check something in the browser, verify a UI or frontend change works, see what a page looks like, or when diagnosing blank pages, console errors, or layout issues in a web app.
allowed-tools: mcp__impala__browser_page_info, mcp__impala__browser_navigate, mcp__impala__browser_click, mcp__impala__browser_type, mcp__impala__browser_screenshot, mcp__impala__browser_console
---

Impala (the desktop app this worktree is open in) has a built-in browser pane next to the code, driven by the `mcp__impala__browser_*` tools. Prefer them over curl, Playwright, or headless browsers for anything the rendered page can answer — the user watches the same pane you're testing, so what you verify is what they see.

## The loop

1. `mcp__impala__browser_page_info` — is a browser pane open, and what page is it on?
2. `mcp__impala__browser_navigate` — go to the page you need (e.g. the dev-server route you changed). If the response has `created: true`, a new browser tab was created; its webview loads once the pane is visible in Impala, so tell the user to open it rather than retrying screenshots in a loop.
3. `mcp__impala__browser_click` — click a button, link, or tab by CSS selector when the flow needs interaction. Events are synthesized (isTrusted: false): fine for app UI, ignored by native controls like file pickers. Screenshot after to confirm what happened.
4. `mcp__impala__browser_type` — set the value of an input/textarea by CSS selector (native setter + input/change events, so React/Vue register it; replaces the whole value, empty string clears).
5. `mcp__impala__browser_screenshot` — SEE the rendered page. This is the ground truth for visual verification.
6. `mcp__impala__browser_console` — read console output, window errors, and unhandled rejections when the page misbehaves. Pass `clear: true` to drain, navigate again to reproduce, then read for a clean signal.

After making a fix, navigate again and screenshot — verify visually before declaring success.

## Notes

- The dev server must be running (usually Impala's Run tab). Connection failures render as a blank page with no error event — a blank screenshot plus an unreachable URL usually means the server is down.
- Console logs are captured per page; they reset on navigation.
- Screenshots show the pane's viewport, not the full scroll height.
- "no browser tab open for this worktree" → ask the user to open one (+ menu → New browser tab), or navigate to create it.
"#;

/// Install a skill to ~/.claude/skills/<name>/SKILL.md
fn install_skill(name: &str, content: &str) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };

    let skill_dir = home.join(".claude").join("skills").join(name);
    if std::fs::create_dir_all(&skill_dir).is_err() {
        return;
    }

    let _ = std::fs::write(skill_dir.join("SKILL.md"), content);
}

/// Install the Impala skills (/impala-review, /impala-browser) for Claude Code.
pub fn install_impala_review_skill() {
    install_skill("impala-review", IMPALA_REVIEW_SKILL);
    install_skill("impala-browser", IMPALA_BROWSER_SKILL);
}

/// macOS only. Maintains one `caffeinate -i` process per worktree that is
/// currently in "working" status. On idle/permission the child is killed
/// so the system can resume normal idle-sleep behaviour.
#[cfg(target_os = "macos")]
fn apply_caffeinate(caffeinators: &Caffeinators, worktree_path: &str, status: &str) {
    let Ok(mut map) = caffeinators.0.lock() else {
        return;
    };
    match status {
        "working" => {
            if map.contains_key(worktree_path) {
                return;
            }
            match std::process::Command::new("caffeinate")
                .arg("-i")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(child) => {
                    map.insert(worktree_path.to_string(), child);
                }
                Err(e) => {
                    eprintln!(
                        "[impala] caffeinate spawn failed for {}: {}",
                        worktree_path, e
                    );
                }
            }
        }
        "idle" | "permission" => {
            if let Some(mut child) = map.remove(worktree_path) {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        _ => {}
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_caffeinate(_caffeinators: &Caffeinators, _worktree_path: &str, _status: &str) {}

/// Dispatch a /browser/* request. Every response is a JSON object with an
/// `ok` flag; errors carry `error`.
fn handle_browser_request(
    app: &AppHandle,
    path: &str,
    params: &HashMap<String, String>,
) -> serde_json::Value {
    // Surface agent activity in the UI (tab dot, toolbar chip, pane ring).
    // Every agent interaction flows through here; user-driven actions go
    // through tauri commands instead, so this is a clean attribution signal.
    if let Some(wt) = params.get("worktree_path").filter(|p| !p.is_empty()) {
        let kind = path.strip_prefix("/browser/").unwrap_or("unknown");
        let _ = app.emit_to(
            "main",
            "browser-agent-activity",
            serde_json::json!({ "worktreePath": wt, "kind": kind }),
        );
    }

    let result = (|| -> Result<serde_json::Value, String> {
        let worktree_path = params
            .get("worktree_path")
            .filter(|p| !p.is_empty())
            .ok_or("missing worktree_path")?;
        match path {
            "/browser/page_info" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                crate::browser::page_info(&wv)
            }
            "/browser/console" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let clear = params.get("clear").map(|c| c == "true").unwrap_or(false);
                crate::browser::console_logs(&wv, clear)
            }
            "/browser/screenshot" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let png_base64 = crate::browser::screenshot_png_base64(&wv)?;
                Ok(serde_json::json!({ "png_base64": png_base64 }))
            }
            "/browser/navigate" => {
                let url = params
                    .get("url")
                    .filter(|u| !u.is_empty())
                    .ok_or("missing url")?;
                crate::browser::navigate_worktree(app, worktree_path, url)
            }
            "/browser/click" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let selector = params
                    .get("selector")
                    .filter(|s| !s.is_empty())
                    .ok_or("missing selector")?;
                crate::browser::click_selector(&wv, selector)
            }
            "/browser/type" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let selector = params
                    .get("selector")
                    .filter(|s| !s.is_empty())
                    .ok_or("missing selector")?;
                // Empty text is legal — it clears the field.
                let text = params.get("text").map(|s| s.as_str()).unwrap_or("");
                crate::browser::type_into_selector(&wv, selector, text)
            }
            _ => Err(format!("unknown browser endpoint: {path}")),
        }
    })();
    match result {
        Ok(mut value) => {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("ok".to_string(), serde_json::Value::Bool(true));
            }
            value
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

/// Start the hook HTTP server on a random port. Returns the port number.
/// The `statuses` map is updated with every event so the frontend can query
/// last-known agent status after a hard reload.
pub fn start(
    app_handle: AppHandle,
    statuses: Arc<AgentStatuses>,
    snapshots: Arc<LastTurnSnapshots>,
    caffeinators: Arc<Caffeinators>,
) -> u16 {
    let server = Arc::new(Server::http("127.0.0.1:0").expect("Failed to start hook server"));
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
            let path = url.splitn(2, '?').next().unwrap_or("").to_string();

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

            // Browser agent-hook endpoints (impala-mcp). Screenshots/eval can
            // take seconds — handle on their own thread so /hook (agent
            // status, latency-critical) never queues behind them.
            if path.starts_with("/browser/") {
                let app = app_handle.clone();
                std::thread::spawn(move || {
                    let body = handle_browser_request(&app, &path, &params);
                    let response = Response::from_string(body.to_string()).with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .expect("static header"),
                    );
                    let _ = request.respond(response);
                });
                continue;
            }

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
                apply_caffeinate(&caffeinators, &worktree_path, status);
                let _ = app_handle.emit(
                    "agent-status",
                    AgentStatusEvent {
                        worktree_path: worktree_path.clone(),
                        status: status.to_string(),
                    },
                );
            }

            // Snapshot the worktree at the start of every turn so the "Last
            // turn" diff view has a baseline. Done synchronously so the
            // snapshot is captured before the agent starts modifying files.
            if event_type == "UserPromptSubmit" && !worktree_path.is_empty() {
                match crate::git::snapshot_worktree(&worktree_path) {
                    Ok(tree) => {
                        if let Ok(mut map) = snapshots.0.lock() {
                            map.insert(worktree_path.clone(), tree);
                        }
                        let _ = app_handle.emit(
                            "last-turn-snapshot-changed",
                            LastTurnSnapshotEvent {
                                worktree_path: worktree_path.clone(),
                            },
                        );
                    }
                    Err(e) => {
                        eprintln!(
                            "[impala] last-turn snapshot failed for {}: {}",
                            worktree_path, e
                        );
                    }
                }
            }

            let _ = request.respond(Response::from_string("ok"));
        }
    });

    port
}
