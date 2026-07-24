use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tiny_http::{Response, Server};

pub struct AgentStatuses(pub Mutex<HashMap<String, String>>);

pub struct AgentPaneStatuses {
    panes: Mutex<HashMap<(String, String), String>>,
    persist: bool,
}

fn runtime_state_path(file_name: &str) -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".impala").join(file_name))
}

fn read_runtime_state<T: DeserializeOwned>(file_name: &str) -> Option<T> {
    let path = runtime_state_path(file_name)?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_runtime_state<T: Serialize>(file_name: &str, value: &T) {
    let Some(path) = runtime_state_path(file_name) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    let Ok(bytes) = serde_json::to_vec(value) else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, bytes).is_ok() {
        if std::fs::rename(&temporary, &path).is_err() {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::rename(&temporary, &path);
        }
    }
}

impl AgentPaneStatuses {
    pub fn load_persisted() -> Self {
        let events: Vec<AgentPaneStatusEvent> =
            read_runtime_state("agent-pane-statuses.json").unwrap_or_default();
        Self {
            panes: Mutex::new(
                events
                    .into_iter()
                    .filter(|event| event.status != "idle")
                    .map(|event| ((event.worktree_path, event.pane_id), event.status))
                    .collect(),
            ),
            persist: true,
        }
    }

    fn persist(&self, panes: &HashMap<(String, String), String>) {
        if !self.persist {
            return;
        }
        let events: Vec<_> = panes
            .iter()
            .map(|((worktree_path, pane_id), status)| AgentPaneStatusEvent {
                worktree_path: worktree_path.clone(),
                pane_id: pane_id.clone(),
                status: status.clone(),
            })
            .collect();
        write_runtime_state("agent-pane-statuses.json", &events);
    }

    fn aggregate(map: &HashMap<(String, String), String>, worktree_path: &str) -> String {
        let statuses = map
            .iter()
            .filter(|((path, _), _)| path == worktree_path)
            .map(|(_, status)| status.as_str());
        if statuses.clone().any(|status| status == "permission") {
            "permission".to_owned()
        } else if statuses.clone().any(|status| status == "working") {
            "working".to_owned()
        } else {
            "idle".to_owned()
        }
    }

    pub fn observe(&self, worktree_path: &str, pane_id: &str, status: &str) -> String {
        let Ok(mut panes) = self.panes.lock() else {
            return status.to_owned();
        };
        let key = (worktree_path.to_owned(), pane_id.to_owned());
        if status == "idle" {
            panes.remove(&key);
        } else {
            panes.insert(key, status.to_owned());
        }
        let aggregate = Self::aggregate(&panes, worktree_path);
        self.persist(&panes);
        aggregate
    }

    pub fn interrupt(&self, worktree_path: &str, pane_id: &str) -> Option<String> {
        self.clear(worktree_path, pane_id)
    }

    pub fn clear(&self, worktree_path: &str, pane_id: &str) -> Option<String> {
        let Ok(mut panes) = self.panes.lock() else {
            return None;
        };
        let key = (worktree_path.to_owned(), pane_id.to_owned());
        panes.remove(&key)?;
        let aggregate = Self::aggregate(&panes, worktree_path);
        self.persist(&panes);
        Some(aggregate)
    }

    pub fn clear_worktree(&self, worktree_path: &str) -> bool {
        let Ok(mut panes) = self.panes.lock() else {
            return false;
        };
        let previous_len = panes.len();
        panes.retain(|(path, _), _| path != worktree_path);
        if panes.len() == previous_len {
            return false;
        }
        self.persist(&panes);
        true
    }

    pub fn snapshot(&self) -> Vec<AgentPaneStatusEvent> {
        let Ok(panes) = self.panes.lock() else {
            return Vec::new();
        };
        panes
            .iter()
            .map(|((worktree_path, pane_id), status)| AgentPaneStatusEvent {
                worktree_path: worktree_path.clone(),
                pane_id: pane_id.clone(),
                status: status.clone(),
            })
            .collect()
    }

    pub fn aggregate_snapshot(&self) -> HashMap<String, String> {
        let Ok(panes) = self.panes.lock() else {
            return HashMap::new();
        };
        let worktrees: HashSet<_> = panes.keys().map(|(path, _)| path.clone()).collect();
        worktrees
            .into_iter()
            .map(|path| {
                let status = Self::aggregate(&panes, &path);
                (path, status)
            })
            .collect()
    }
}

impl Default for AgentPaneStatuses {
    fn default() -> Self {
        Self {
            panes: Mutex::new(HashMap::new()),
            persist: false,
        }
    }
}

pub struct InterruptedAgentTurns {
    panes: Mutex<HashSet<(String, String)>>,
    persist: bool,
}

impl InterruptedAgentTurns {
    pub fn load_persisted() -> Self {
        let keys: Vec<AgentPaneKey> =
            read_runtime_state("interrupted-agent-turns.json").unwrap_or_default();
        Self {
            panes: Mutex::new(
                keys.into_iter()
                    .map(|key| (key.worktree_path, key.pane_id))
                    .collect(),
            ),
            persist: true,
        }
    }

    fn persist(&self, panes: &HashSet<(String, String)>) {
        if !self.persist {
            return;
        }
        let keys: Vec<_> = panes
            .iter()
            .map(|(worktree_path, pane_id)| AgentPaneKey {
                worktree_path: worktree_path.clone(),
                pane_id: pane_id.clone(),
            })
            .collect();
        write_runtime_state("interrupted-agent-turns.json", &keys);
    }

    pub fn mark(&self, worktree_path: &str, pane_id: &str) {
        if let Ok(mut panes) = self.panes.lock() {
            panes.insert((worktree_path.to_owned(), pane_id.to_owned()));
            self.persist(&panes);
        }
    }

    fn suppresses(&self, worktree_path: &str, pane_id: &str, event_type: &str) -> bool {
        let Ok(mut panes) = self.panes.lock() else {
            return false;
        };
        let key = (worktree_path.to_owned(), pane_id.to_owned());
        if matches!(event_type, "SessionStart" | "UserPromptSubmit") {
            panes.remove(&key);
            self.persist(&panes);
            return false;
        }
        panes.contains(&key)
    }
}

impl Default for InterruptedAgentTurns {
    fn default() -> Self {
        Self {
            panes: Mutex::new(HashSet::new()),
            persist: false,
        }
    }
}

#[derive(Deserialize, Serialize)]
struct AgentPaneKey {
    worktree_path: String,
    pane_id: String,
}

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

#[derive(Clone, Deserialize, Serialize)]
pub struct AgentPaneStatusEvent {
    pub worktree_path: String,
    pub pane_id: String,
    pub status: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct AutomationTurnActivity {
    turn_id: Option<String>,
    active_tool_ids: HashSet<String>,
    stop_seen: bool,
}

/// A Stop hook means the lead turn stopped, but Codex may still have yielded
/// shell tools running in the background. Keep the run active until every
/// PreToolUse has a matching PostToolUse/PostToolUseFailure.
#[derive(Default)]
struct AutomationCompletionTracker {
    turns: HashMap<(String, String), AutomationTurnActivity>,
    persist: bool,
}

impl AutomationCompletionTracker {
    fn load_persisted() -> Self {
        let turns: Vec<PersistedAutomationTurn> =
            read_runtime_state("automation-turns.json").unwrap_or_default();
        Self {
            turns: turns
                .into_iter()
                .map(|turn| ((turn.worktree_path, turn.pane_id), turn.activity))
                .collect(),
            persist: true,
        }
    }

    fn persist(&self) {
        if !self.persist {
            return;
        }
        let turns: Vec<_> = self
            .turns
            .iter()
            .map(
                |((worktree_path, pane_id), activity)| PersistedAutomationTurn {
                    worktree_path: worktree_path.clone(),
                    pane_id: pane_id.clone(),
                    activity: activity.clone(),
                },
            )
            .collect();
        write_runtime_state("automation-turns.json", &turns);
    }

    fn observe(
        &mut self,
        worktree_path: &str,
        pane_id: &str,
        event_type: &str,
        payload: &str,
    ) -> bool {
        let key = (worktree_path.to_owned(), pane_id.to_owned());
        let payload: serde_json::Value =
            serde_json::from_str(payload).unwrap_or(serde_json::Value::Null);
        let turn_id = payload
            .get("turn_id")
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let tool_use_id = payload
            .get("tool_use_id")
            .and_then(|value| value.as_str())
            .map(str::to_owned);

        let should_complete = match event_type {
            "SessionStart" => {
                self.turns.remove(&key);
                false
            }
            "UserPromptSubmit" => {
                self.turns.insert(
                    key,
                    AutomationTurnActivity {
                        turn_id,
                        ..Default::default()
                    },
                );
                false
            }
            "PreToolUse" => {
                let activity = self.turns.entry(key).or_default();
                if activity.turn_id.is_none() {
                    activity.turn_id = turn_id;
                }
                if let Some(tool_use_id) = tool_use_id {
                    activity.active_tool_ids.insert(tool_use_id);
                }
                false
            }
            "PostToolUse" | "PostToolUseFailure" => {
                let Some(activity) = self.turns.get_mut(&key) else {
                    return false;
                };
                if let Some(tool_use_id) = tool_use_id {
                    activity.active_tool_ids.remove(&tool_use_id);
                }
                let should_complete = activity.stop_seen && activity.active_tool_ids.is_empty();
                if should_complete {
                    self.turns.remove(&key);
                }
                should_complete
            }
            "Stop" => {
                let Some(activity) = self.turns.get_mut(&key) else {
                    // After a hook-server restart we cannot prove that an
                    // already-running turn has no background tools. Keep its
                    // automation launched instead of reporting false success.
                    return false;
                };
                if activity.turn_id.is_some() && turn_id.is_some() && activity.turn_id != turn_id {
                    return false;
                }
                activity.stop_seen = true;
                let should_complete = activity.active_tool_ids.is_empty();
                if should_complete {
                    self.turns.remove(&key);
                }
                should_complete
            }
            _ => false,
        };
        self.persist();
        should_complete
    }

    fn has_active_tools(&self, worktree_path: &str, pane_id: &str) -> bool {
        self.turns
            .get(&(worktree_path.to_owned(), pane_id.to_owned()))
            .map(|activity| !activity.active_tool_ids.is_empty())
            .unwrap_or(false)
    }
}

#[derive(Deserialize, Serialize)]
struct PersistedAutomationTurn {
    worktree_path: String,
    pane_id: String,
    activity: AutomationTurnActivity,
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
/// even after an app restart changes the port. Stdin must be drained first:
/// the agent writes the full event payload to hook stdin, and a PostToolUse
/// payload carrying a browser screenshot exceeds the 64KB pipe buffer — a
/// command that exits without reading gives the agent a broken-pipe error.
/// Stdout is fully suppressed: Codex parses hook stdout as JSON and chokes
/// on non-JSON bodies (Claude Code ignores stdout entirely), so we make
/// sure neither sees the HTTP response body.
fn hook_command(event_type: &str) -> String {
    format!(
        "IMPALA_HOOK_PORT=$(cat ~/.impala/hook-port 2>/dev/null); if [ -n \"$IMPALA_WORKTREE_PATH\" ] && [ -n \"$IMPALA_HOOK_PORT\" ]; then curl -sS -X POST \"http://127.0.0.1:${{IMPALA_HOOK_PORT}}/hook\" --url-query \"event_type={}\" --url-query \"worktree_path=${{IMPALA_WORKTREE_PATH}}\" --url-query \"pane_id=${{IMPALA_PANE_ID}}\" --url-query \"agent_provider=${{IMPALA_AGENT_PROVIDER}}\" --data-binary @- --connect-timeout 1 --max-time 2 >/dev/null 2>&1; else cat >/dev/null 2>&1; fi; true",
        event_type
    )
}

const IMPALA_REVIEW_SKILL: &str = r#"---
name: impala-review
description: Review and address code review annotations from Impala. Use when asked to review annotations, or when invoked as /impala-review.
allowed-tools: mcp__impala__list_annotations, mcp__impala__resolve_annotation, mcp__impala__list_files_with_annotations, mcp__impala__get_browser_annotation_screenshot, mcp__impala__browser_navigate, mcp__impala__browser_click, mcp__impala__browser_click_at, mcp__impala__browser_scroll, mcp__impala__browser_type, mcp__impala__browser_screenshot, mcp__impala__browser_console, mcp__impala__browser_page_info, Read, Edit, Write, Grep, Glob
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
description: Verify or diagnose the running app in Impala's built-in browser. Use only in an Impala-hosted agent session where the runtime guard succeeds. Never use this skill for browser work outside Impala.
allowed-tools: Bash(test:*), mcp__impala__browser_page_info, mcp__impala__browser_navigate, mcp__impala__browser_click, mcp__impala__browser_click_at, mcp__impala__browser_scroll, mcp__impala__browser_type, mcp__impala__browser_screenshot, mcp__impala__browser_console
---

Impala (the desktop app this worktree is open in) has a built-in browser pane next to the code, driven by the `mcp__impala__browser_*` tools. Prefer them over curl, Playwright, or headless browsers for anything the rendered page can answer — the user watches the same pane you're testing, so what you verify is what they see.

## Runtime guard

Before calling any `mcp__impala__browser_*` tool, run:

```sh
test -n "${IMPALA_WORKTREE_PATH:-}" && test -n "${IMPALA_PANE_ID:-}"
```

If the command fails, stop using this skill and do not call any Impala browser tools. Tell the user that the Impala browser is available only from an agent session running inside the Impala app. Do not substitute another browser unless the user asks.

## The loop

1. `mcp__impala__browser_page_info` — is a browser pane open, and what page is it on?
2. `mcp__impala__browser_navigate` — go to the page you need (e.g. the dev-server route you changed). If the response has `created: true`, a new browser tab was created; its webview loads once the pane is visible in Impala, so tell the user to open it rather than retrying screenshots in a loop.
3. `mcp__impala__browser_click` — click a button, link, or tab by CSS selector when the flow needs interaction. Delivers real platform input (isTrusted: true with user activation — clipboard and native controls respond; window.open popups stay blocked). A visible cursor glides to the target in the pane. Screenshot after to confirm what happened.
4. `mcp__impala__browser_type` — click-focuses the element by CSS selector, then types the text as real keystrokes (keydown/input events fire, so React/Vue and shortcut handlers register it; replaces the current value, empty string clears, newlines press Return).
5. `mcp__impala__browser_click_at` — click at raw viewport coordinates (CSS px, origin top-left) when no selector exists (canvas, maps). Pair with `browser_screenshot`; screenshots are captured at the display's scale factor, so divide screenshot pixels by (screenshot width / viewport width from `browser_page_info`).
6. `mcp__impala__browser_scroll` — scroll with a real wheel event at the viewport center (positive dy scrolls down; dx optional).
7. `mcp__impala__browser_screenshot` — SEE the rendered page. This is the ground truth for visual verification.
8. `mcp__impala__browser_console` — read console output, window errors, and unhandled rejections when the page misbehaves. Pass `clear: true` to drain, navigate again to reproduce, then read for a clean signal.

After making a fix, navigate again and screenshot — verify visually before declaring success.

## Notes

- Clicks are real input: they can open native OS dialogs (file pickers) that you cannot drive — tell the user when one is needed.
- The dev server must be running (usually Impala's Run tab). Connection failures render as a blank page with no error event — a blank screenshot plus an unreachable URL usually means the server is down.
- Console logs are captured per page; they reset on navigation.
- Screenshots show the pane's viewport, not the full scroll height.
- "no browser tab open for this worktree" → ask the user to open one (+ menu → New browser tab), or navigate to create it.
"#;

const IMPALA_AUTOMATIONS_SKILL: &str = r#"---
name: impala-automations
description: Schedule recurring agent runs in Impala. Use when the user asks for work on a schedule — "every morning", "daily", "check this weekly", "keep an eye on this" — or wants to list, edit, pause, resume, or trigger scheduled automations.
allowed-tools: mcp__impala__list_automations, mcp__impala__create_automation, mcp__impala__update_automation, mcp__impala__run_automation_now, mcp__impala__set_automation_enabled
---

Impala (the desktop app this worktree is open in) runs scheduled automations: name + prompt + schedule + agent, per project. At each fire Impala creates a fresh worktree, launches the agent with the prompt, and the finished run lands as a reviewable diff with a badge in the app. Runs fire only while Impala is open; a slot missed while it was closed fires once on next launch.

## Tools

- `mcp__impala__list_automations` — automations + recent runs for this project. Call this FIRST before creating; if a similar one exists, edit it with update_automation instead of stacking a duplicate.
- `mcp__impala__create_automation` — name, prompt, schedule; agent defaults to this worktree's agent.
- `mcp__impala__update_automation` — edit an existing automation by id; pass only the fields to change (name, prompt, schedule, agent). Changing the schedule recomputes the next run from now.
- `mcp__impala__run_automation_now` — trigger one run immediately (creates a real worktree; say so before doing it).
- `mcp__impala__set_automation_enabled` — pause (false) / resume (true). Resuming skips occurrences missed while paused.

## Schedules

5-field cron, evaluated in the machine's local timezone. Common shapes: `0 9 * * *` daily 9:00, `0 9 * * MON-FRI` weekday mornings, `0 17 * * FRI` Friday 17:00, `0 * * * *` hourly.

## Writing automation prompts

The prompt runs unattended in a fresh worktree with nobody there to answer questions, so make it self-contained and decisive: state exactly what to examine, what to change or produce, and where to put it. Have it write results into files (e.g. `docs/<topic>/<date>.md`) or make the fixes directly — the diff IS the deliverable the user reviews. Never write a prompt that only prints to the terminal.

When the user's request is ambiguous about cadence or scope ("keep an eye on this"), propose a concrete name + schedule + prompt and confirm before creating.
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

/// Install the Impala skills (/impala-review, /impala-browser,
/// /impala-automations) for Claude Code.
pub fn install_impala_review_skill() {
    install_skill("impala-review", IMPALA_REVIEW_SKILL);
    install_skill("impala-browser", IMPALA_BROWSER_SKILL);
    install_skill("impala-automations", IMPALA_AUTOMATIONS_SKILL);
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

pub fn publish_agent_status(
    app_handle: &AppHandle,
    statuses: &AgentStatuses,
    caffeinators: &Caffeinators,
    worktree_path: &str,
    status: &str,
) {
    if let Ok(mut map) = statuses.0.lock() {
        map.insert(worktree_path.to_owned(), status.to_owned());
    }
    apply_caffeinate(caffeinators, worktree_path, status);
    let _ = app_handle.emit(
        "agent-status",
        AgentStatusEvent {
            worktree_path: worktree_path.to_owned(),
            status: status.to_owned(),
        },
    );
}

pub fn publish_agent_pane_event(
    app_handle: &AppHandle,
    worktree_path: &str,
    pane_id: &str,
    status: &str,
) {
    let _ = app_handle.emit(
        "agent-pane-status",
        AgentPaneStatusEvent {
            worktree_path: worktree_path.to_owned(),
            pane_id: pane_id.to_owned(),
            status: status.to_owned(),
        },
    );
}

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
                crate::browser::click_selector(app, &wv, selector)
            }
            "/browser/click_at" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let x = params
                    .get("x")
                    .and_then(|v| v.parse::<f64>().ok())
                    .ok_or("missing or invalid x")?;
                let y = params
                    .get("y")
                    .and_then(|v| v.parse::<f64>().ok())
                    .ok_or("missing or invalid y")?;
                crate::browser::click_at(app, &wv, x, y)
            }
            "/browser/scroll" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let dy = params
                    .get("dy")
                    .and_then(|v| v.parse::<f64>().ok())
                    .ok_or("missing or invalid dy")?;
                let dx = params
                    .get("dx")
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0);
                crate::browser::scroll(app, &wv, dx, dy)
            }
            "/browser/type" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let selector = params
                    .get("selector")
                    .filter(|s| !s.is_empty())
                    .ok_or("missing selector")?;
                // Empty text is legal — it clears the field.
                let text = params.get("text").map(|s| s.as_str()).unwrap_or("");
                crate::browser::type_into_selector(app, &wv, selector, text)
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

/// Dispatch an /automations/* request (impala-mcp's automation tools). Same
/// contract as /browser/*: JSON object with an `ok` flag, errors in `error`.
/// Automations are keyed by the main repo path, so worktree-scoped calls
/// resolve through the .git gitdir link first.
fn handle_automation_request(
    app: &AppHandle,
    path: &str,
    params: &HashMap<String, String>,
) -> serde_json::Value {
    use tauri::Manager;

    let result = (|| -> Result<serde_json::Value, String> {
        let state = app.state::<crate::DbState>();
        let conn = state
            .0
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;

        let resolve_repo = || -> Result<String, String> {
            let worktree_path = params
                .get("worktree_path")
                .filter(|p| !p.is_empty())
                .ok_or("missing worktree_path")?;
            crate::agent_config::main_worktree_root(std::path::Path::new(worktree_path))
                .map(|p| p.to_string_lossy().to_string())
                .ok_or_else(|| "not inside a git repository".to_string())
        };
        let require = |key: &str| -> Result<&String, String> {
            params
                .get(key)
                .filter(|v| !v.is_empty())
                .ok_or(format!("missing {key}"))
        };

        match path {
            "/automations/list" => {
                let repo = resolve_repo()?;
                let automations = crate::automations::list_by_repo(&conn, &repo)?;
                let runs = crate::automations::list_runs_by_repo(&conn, &repo)?;
                Ok(serde_json::json!({ "automations": automations, "recent_runs": runs }))
            }
            "/automations/create" => {
                let repo = resolve_repo()?;
                // Default the agent to the calling worktree's own agent —
                // "check this again every morning" means "as me".
                let agent = match params.get("agent").filter(|a| !a.is_empty()) {
                    Some(a) => a.clone(),
                    None => params
                        .get("worktree_path")
                        .and_then(|wt| {
                            crate::settings::get_setting(&conn, "selectedAgent", wt)
                                .ok()
                                .flatten()
                        })
                        .unwrap_or_else(|| "claude".to_string()),
                };
                let created = crate::automations::create_automation_row(
                    &conn,
                    crate::automations::NewAutomation {
                        repo_path: repo,
                        name: require("name")?.clone(),
                        prompt: require("prompt")?.clone(),
                        agent,
                        schedule: require("schedule")?.clone(),
                    },
                    chrono::Utc::now().timestamp(),
                )?;
                let _ = app.emit("automations-changed", ());
                Ok(serde_json::json!({ "automation": created }))
            }
            "/automations/update" => {
                let id = require("id")?;
                let optional = |key: &str| params.get(key).filter(|v| !v.is_empty()).cloned();
                let updated = crate::automations::update_automation_row(
                    &conn,
                    id,
                    crate::automations::UpdateAutomation {
                        name: optional("name"),
                        prompt: optional("prompt"),
                        agent: optional("agent"),
                        schedule: optional("schedule"),
                        repo_path: None,
                    },
                    chrono::Utc::now().timestamp(),
                )?;
                let _ = app.emit("automations-changed", ());
                Ok(serde_json::json!({ "automation": updated }))
            }
            "/automations/run_now" => {
                let id = require("id")?;
                let automation = crate::automations::get_automation(&conn, id)?;
                crate::automations::dispatch(
                    app,
                    &conn,
                    &automation,
                    chrono::Utc::now().timestamp(),
                )?;
                Ok(serde_json::json!({ "started": automation.name }))
            }
            "/automations/set_enabled" => {
                let id = require("id")?;
                let enabled = require("enabled")? == "true";
                crate::automations::set_enabled_row(
                    &conn,
                    id,
                    enabled,
                    chrono::Utc::now().timestamp(),
                )?;
                let _ = app.emit("automations-changed", ());
                Ok(serde_json::json!({ "enabled": enabled }))
            }
            _ => Err(format!("unknown automations endpoint: {path}")),
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

fn handle_agent_request(
    app: &AppHandle,
    path: &str,
    params: &HashMap<String, String>,
) -> serde_json::Value {
    let result = (|| -> Result<serde_json::Value, String> {
        if path != "/agents/open" {
            return Err(format!("unknown agents endpoint: {path}"));
        }
        let worktree_path = params
            .get("worktree_path")
            .filter(|value| !value.is_empty())
            .ok_or("missing worktree_path")?;
        let prompt = params
            .get("prompt")
            .filter(|value| !value.trim().is_empty())
            .ok_or("missing prompt")?;
        let agent = params.get("agent").filter(|value| !value.is_empty());
        if let Some(agent) = agent {
            if agent != "claude" && agent != "codex" {
                return Err("agent must be 'claude' or 'codex'".to_string());
            }
        }
        let source_pane_id = params
            .get("source_pane_id")
            .filter(|value| !value.trim().is_empty());
        let placement = params
            .get("placement")
            .map(String::as_str)
            .unwrap_or("auto");
        if !matches!(placement, "auto" | "current" | "left" | "right") {
            return Err("placement must be 'auto', 'current', 'left', or 'right'".to_string());
        }

        app.emit_to(
            "main",
            "agent-tab-request-open",
            serde_json::json!({
                "worktreePath": worktree_path,
                "prompt": prompt,
                "agent": agent,
                "sourcePaneId": source_pane_id,
                "placement": placement,
            }),
        )
        .map_err(|e| format!("failed to open agent tab: {e}"))?;

        Ok(serde_json::json!({
            "opened": true,
            "agent": agent.map(|value| value.as_str()).unwrap_or("configured"),
        }))
    })();

    match result {
        Ok(mut value) => {
            value["ok"] = serde_json::Value::Bool(true);
            value
        }
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}

/// Start the hook HTTP server on a random port. Returns the port number.
/// The `statuses` map is updated with every event so the frontend can query
/// last-known agent status after a hard reload.
pub fn start(
    app_handle: AppHandle,
    statuses: Arc<AgentStatuses>,
    pane_statuses: Arc<AgentPaneStatuses>,
    snapshots: Arc<LastTurnSnapshots>,
    caffeinators: Arc<Caffeinators>,
    interrupted_turns: Arc<InterruptedAgentTurns>,
    subagents: Arc<crate::subagents::SubagentRegistry>,
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
        let mut automation_completion = AutomationCompletionTracker::load_persisted();
        for mut request in server.incoming_requests() {
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
                    // Clients (curl -G --data-urlencode, reqwest's
                    // parse_with_params) send form encoding: space arrives
                    // as '+', a literal '+' as %2B — undo the '+' first.
                    let value = value.replace('+', " ");
                    Some((
                        key.to_string(),
                        urlencoding::decode(&value).unwrap_or_default().into_owned(),
                    ))
                })
                .collect();

            // Browser agent-hook endpoints (impala-mcp). Screenshots/eval can
            // take seconds — handle on their own thread so /hook (agent
            // status, latency-critical) never queues behind them.
            if path.starts_with("/browser/")
                || path.starts_with("/automations/")
                || path.starts_with("/agents/")
            {
                let app = app_handle.clone();
                std::thread::spawn(move || {
                    let body = if path.starts_with("/browser/") {
                        handle_browser_request(&app, &path, &params)
                    } else if path.starts_with("/agents/") {
                        handle_agent_request(&app, &path, &params)
                    } else {
                        handle_automation_request(&app, &path, &params)
                    };
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
            let pane_id = params
                .get("pane_id")
                .filter(|value| !value.is_empty())
                .cloned()
                .unwrap_or_else(|| "tab-agent".to_owned());
            let provider = params
                .get("agent_provider")
                .map(String::as_str)
                .unwrap_or_default();
            let mut hook_payload = String::new();
            let _ = request.as_reader().read_to_string(&mut hook_payload);

            subagents.ingest_hook(
                &app_handle,
                &worktree_path,
                &pane_id,
                provider,
                event_type,
                &hook_payload,
            );

            let suppress_interrupted_event =
                interrupted_turns.suppresses(&worktree_path, &pane_id, event_type);
            let automation_should_complete = if worktree_path.is_empty()
                || pane_id != "tab-agent"
                || suppress_interrupted_event
            {
                false
            } else {
                automation_completion.observe(&worktree_path, &pane_id, event_type, &hook_payload)
            };
            let status = if suppress_interrupted_event {
                ""
            } else {
                match event_type {
                    "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => {
                        if automation_should_complete {
                            "idle"
                        } else {
                            "working"
                        }
                    }
                    "Stop" => {
                        if automation_completion.has_active_tools(&worktree_path, &pane_id) {
                            "working"
                        } else {
                            "idle"
                        }
                    }
                    "PermissionRequest" => "permission",
                    _ => "",
                }
            };

            // A stopped lead turn completes its launched automation only
            // after any yielded background tools have also finished. Emitted
            // before agent-status so the frontend can specialize the
            // completion notification.
            if automation_should_complete && !worktree_path.is_empty() {
                use tauri::Manager;
                let state = app_handle.state::<crate::DbState>();
                let completed_name = state
                    .0
                    .lock()
                    .ok()
                    .and_then(|conn| {
                        crate::automations::complete_run_for_worktree(&conn, &worktree_path).ok()
                    })
                    .flatten();
                if let Some(automation_name) = completed_name {
                    let _ = app_handle.emit(
                        "automation-run-completed",
                        serde_json::json!({
                            "worktree_path": worktree_path,
                            "automation_name": automation_name,
                        }),
                    );
                    let _ = app_handle.emit("automation-runs-changed", ());
                }
            }

            if !status.is_empty() && !worktree_path.is_empty() {
                let aggregate_status = pane_statuses.observe(&worktree_path, &pane_id, status);
                publish_agent_pane_event(&app_handle, &worktree_path, &pane_id, status);
                publish_agent_status(
                    &app_handle,
                    &statuses,
                    &caffeinators,
                    &worktree_path,
                    &aggregate_status,
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

#[cfg(test)]
mod tests {
    use super::{
        AgentPaneStatuses, AutomationCompletionTracker, InterruptedAgentTurns, IMPALA_BROWSER_SKILL,
    };

    #[test]
    fn browser_skill_requires_impala_runtime_context() {
        assert!(IMPALA_BROWSER_SKILL
            .contains(r#"test -n "${IMPALA_WORKTREE_PATH:-}" && test -n "${IMPALA_PANE_ID:-}""#));
        assert!(IMPALA_BROWSER_SKILL.contains("If the command fails, stop using this skill"));
    }

    #[test]
    fn stop_waits_for_background_tools_before_completing_an_automation_turn() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        assert!(!tracker.observe(
            worktree,
            pane,
            "UserPromptSubmit",
            r#"{"turn_id":"turn-1"}"#,
        ));
        assert!(!tracker.observe(
            worktree,
            pane,
            "PreToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-1"}"#,
        ));

        // Codex can stop the lead turn while a yielded exec is still running.
        assert!(!tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"turn-1"}"#));

        // Completion becomes eligible only when the outstanding tool finishes.
        assert!(tracker.observe(
            worktree,
            pane,
            "PostToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-1"}"#,
        ));
    }

    #[test]
    fn stop_completes_immediately_when_the_turn_has_no_active_tools() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        tracker.observe(
            worktree,
            pane,
            "UserPromptSubmit",
            r#"{"turn_id":"turn-1"}"#,
        );

        assert!(tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"turn-1"}"#));
        assert!(!tracker.has_active_tools(worktree, pane));
    }

    #[test]
    fn background_completion_waits_for_every_active_tool() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        tracker.observe(
            worktree,
            pane,
            "UserPromptSubmit",
            r#"{"turn_id":"turn-1"}"#,
        );
        tracker.observe(
            worktree,
            pane,
            "PreToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-1"}"#,
        );
        tracker.observe(
            worktree,
            pane,
            "PreToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-2"}"#,
        );
        assert!(!tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"turn-1"}"#));
        assert!(!tracker.observe(
            worktree,
            pane,
            "PostToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-1"}"#,
        ));
        assert!(tracker.has_active_tools(worktree, pane));
        assert!(tracker.observe(
            worktree,
            pane,
            "PostToolUseFailure",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-2"}"#,
        ));
    }

    #[test]
    fn stale_stop_cannot_complete_a_newer_turn() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        tracker.observe(
            worktree,
            pane,
            "UserPromptSubmit",
            r#"{"turn_id":"turn-2"}"#,
        );

        assert!(!tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"turn-1"}"#));
    }

    #[test]
    fn an_unobserved_stop_cannot_prove_automation_completion() {
        let mut tracker = AutomationCompletionTracker::default();

        assert!(!tracker.observe(
            "/worktrees/restarted-automation",
            "tab-agent",
            "Stop",
            r#"{"turn_id":"turn-before-restart"}"#,
        ));
    }

    #[test]
    fn automation_completion_activity_is_isolated_by_pane() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";

        tracker.observe(
            worktree,
            "tab-agent",
            "UserPromptSubmit",
            r#"{"turn_id":"automation"}"#,
        );
        tracker.observe(
            worktree,
            "secondary-agent",
            "UserPromptSubmit",
            r#"{"turn_id":"manual"}"#,
        );
        tracker.observe(
            worktree,
            "tab-agent",
            "PreToolUse",
            r#"{"turn_id":"automation","tool_use_id":"tool-1"}"#,
        );

        assert!(tracker.observe(
            worktree,
            "secondary-agent",
            "Stop",
            r#"{"turn_id":"manual"}"#,
        ));
        assert!(!tracker.observe(worktree, "tab-agent", "Stop", r#"{"turn_id":"automation"}"#,));
        assert!(tracker.observe(
            worktree,
            "tab-agent",
            "PostToolUse",
            r#"{"turn_id":"automation","tool_use_id":"tool-1"}"#,
        ));
    }

    #[test]
    fn a_child_turn_can_finish_its_background_tool_after_the_lead_stops() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        tracker.observe(worktree, pane, "UserPromptSubmit", r#"{"turn_id":"lead"}"#);
        tracker.observe(
            worktree,
            pane,
            "PreToolUse",
            r#"{"turn_id":"child","tool_use_id":"tool-1"}"#,
        );
        assert!(!tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"lead"}"#));
        assert!(tracker.observe(
            worktree,
            pane,
            "PostToolUse",
            r#"{"turn_id":"child","tool_use_id":"tool-1"}"#,
        ));
    }

    #[test]
    fn late_hooks_stay_suppressed_until_a_new_turn_starts() {
        let interrupted = InterruptedAgentTurns::default();
        let worktree = "/worktrees/interrupted";
        let pane = "pane-1";

        interrupted.mark(worktree, pane);
        assert!(interrupted.suppresses(worktree, pane, "PostToolUseFailure"));
        assert!(interrupted.suppresses(worktree, pane, "Stop"));
        assert!(!interrupted.suppresses(worktree, pane, "UserPromptSubmit"));
        assert!(!interrupted.suppresses(worktree, pane, "PostToolUse"));
    }

    #[test]
    fn interrupted_turn_suppression_is_scoped_to_one_pane() {
        let interrupted = InterruptedAgentTurns::default();
        let worktree = "/worktrees/interrupted";

        interrupted.mark(worktree, "pane-1");

        assert!(interrupted.suppresses(worktree, "pane-1", "Stop"));
        assert!(!interrupted.suppresses(worktree, "pane-2", "Stop"));
    }

    #[test]
    fn pane_statuses_keep_the_worktree_active_until_every_agent_is_idle() {
        let panes = AgentPaneStatuses::default();
        let worktree = "/worktrees/multiple-agents";

        assert_eq!(panes.observe(worktree, "pane-1", "working"), "working");
        assert_eq!(panes.observe(worktree, "pane-2", "working"), "working");
        assert_eq!(
            panes.interrupt(worktree, "pane-1"),
            Some("working".to_owned())
        );
        assert_eq!(panes.interrupt(worktree, "pane-2"), Some("idle".to_owned()));
    }

    #[test]
    fn shell_interrupts_do_not_change_agent_lifecycle() {
        let panes = AgentPaneStatuses::default();

        assert_eq!(panes.interrupt("/worktrees/shell", "terminal-pane"), None);
    }

    #[test]
    fn clearing_a_worktree_drops_every_persisted_pane_activity() {
        let panes = AgentPaneStatuses::default();
        let worktree = "/worktrees/removed";
        panes.observe(worktree, "pane-1", "working");
        panes.observe(worktree, "pane-2", "permission");

        assert!(panes.clear_worktree(worktree));
        assert!(panes.snapshot().is_empty());
        assert!(!panes.clear_worktree(worktree));
    }

    #[test]
    fn permission_has_priority_in_the_worktree_aggregate() {
        let panes = AgentPaneStatuses::default();
        let worktree = "/worktrees/permissions";

        panes.observe(worktree, "pane-1", "working");
        assert_eq!(
            panes.observe(worktree, "pane-2", "permission"),
            "permission"
        );
        assert_eq!(panes.observe(worktree, "pane-2", "idle"), "working");
    }
}
