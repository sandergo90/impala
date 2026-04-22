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

const IMPALA_HOOK_MARKER: &str = "IMPALA_HOOK_PORT";

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

/// Merge Impala hooks into ~/.claude/settings.json, preserving all other settings and hooks.
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
        ("PostToolUseFailure", true),
        ("PermissionRequest", false),
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

        // Remove any existing Impala-managed hooks (identified by marker)
        for def in defs.iter_mut() {
            if let Some(hook_list) = def.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                let before_len = hook_list.len();
                hook_list.retain(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| !c.contains(IMPALA_HOOK_MARKER))
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
                            .map(|c| c.contains(IMPALA_HOOK_MARKER))
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

const IMPALA_REVIEW_SKILL: &str = r#"---
name: impala-review
description: Review and address code review annotations from Impala. Use when asked to review annotations, or when invoked as /impala-review.
allowed-tools: mcp__impala__list_annotations, mcp__impala__resolve_annotation, mcp__impala__list_files_with_annotations, Read, Edit, Write, Grep, Glob
argument-hint: "[annotation-id]"
---

Review and address code review annotations from Impala using the MCP server tools. These are human-written review comments anchored to specific lines in the code.

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
- `file_path` — the file the annotation is on
- `line_number` — the line number in the file
- `side` — `left` means the annotation is on the old/deleted code, `right` means new/added code
- `body` — the reviewer's comment text
- `resolved` — boolean, only unresolved annotations are returned

## Important Notes

- **Every annotation gets addressed** — no silent skips
- **Ask the user when uncertain** — don't guess on architectural or business logic questions
- **Verify before fixing** — read the code context, understand the intent, then act
- **Keep fixes minimal** — only change what the annotation asks for
- **Work file by file** — group annotations by file to avoid redundant file reads
"#;

/// Install the /impala-review skill to ~/.claude/skills/impala-review/SKILL.md
pub fn install_impala_review_skill() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };

    let skill_dir = home.join(".claude").join("skills").join("impala-review");
    if let Err(_) = std::fs::create_dir_all(&skill_dir) {
        return;
    }

    let skill_path = skill_dir.join("SKILL.md");
    let _ = std::fs::write(&skill_path, IMPALA_REVIEW_SKILL);
}

const IMPALA_PLAN_SKILL: &str = r#"---
name: impala-plan
description: Submit an implementation plan to Impala's Plan tab for user review, wait for the decision, and loop on annotations until approved. Use when you have a finished plan file and want the user to approve (or revise) it in the Impala desktop app before execution.
allowed-tools: mcp__impala__submit_plan_for_review, mcp__impala__get_plan_decision, mcp__impala__resolve_annotation, Bash, Read, Edit, Write
argument-hint: "<plan-path>"
---

Run the full plan-review loop with Impala: register the plan, wait for the user's decision in the Plan tab, handle annotations, loop until approved.

Invoke this after a plan file (or plan directory with `overview.md`) has been written. This skill owns review — not writing the plan, and not executing it.

## Phase 1: Register

Call `mcp__impala__submit_plan_for_review` with:

- `plan_path`: absolute path to the plan's `overview.md` (or the single task file for a one-task plan)
- `title`: the feature name
- `worktree_path`: absolute path to the current working directory

Capture the returned `signal_path` from the response. It's the file Impala will write when the user decides.

## Phase 2: Wait

Start a background watcher on the signal file using the Bash tool with `run_in_background: true`:

```bash
until [ -f "<signal_path>" ]; do sleep 2; done; cat "<signal_path>"
```

Then tell the user:

**"Plan submitted to Impala's Plan tab. Approve it there, or leave annotations and I'll address them when you're done."**

End your turn. You'll be notified in a new turn when the watcher finishes (the signal file appeared). If the user replies in chat before that, treat their message as the decision and stop the watcher.

## Phase 3: Handle the Decision

On wake-up, call `mcp__impala__get_plan_decision` with the same `plan_path` and `worktree_path`. Branch on `plan.status`:

- **`approved`** → report "Plan approved." and stop. If the caller expects execution to follow, hand off to their execution flow (e.g. the `implement-plans` skill).
- **anything else** (annotations added, changes requested, rejected) →
  1. Read each annotation's `original_text` and `body` — `original_text` is the exact snippet of the plan the reviewer highlighted.
  2. Revise the plan file(s) to address the feedback — edit in place, don't create new plan files.
  3. After addressing each annotation, call `mcp__impala__resolve_annotation` with its `id` to mark it resolved. Every annotation gets resolved — no silent skips.
  4. Go back to Phase 1: call `submit_plan_for_review` again on the same `plan_path`. It auto-increments `version`, so no IDs or paths need to change. Start a new watcher on the new `signal_path`, end the turn, loop.

## Notes

- Do not execute the plan yourself. This skill is about review, not execution.
- Do not poll `get_plan_decision` in a tight loop — always wait via the background watcher so your turn ends cleanly and the user can interact.
- The `plans` table is the source of truth. The signal file is only a wake-up ping.
"#;

/// Install the /impala-plan skill to ~/.claude/skills/impala-plan/SKILL.md
pub fn install_impala_plan_skill() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };

    let skill_dir = home.join(".claude").join("skills").join("impala-plan");
    if let Err(_) = std::fs::create_dir_all(&skill_dir) {
        return;
    }

    let skill_path = skill_dir.join("SKILL.md");
    let _ = std::fs::write(&skill_path, IMPALA_PLAN_SKILL);
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
