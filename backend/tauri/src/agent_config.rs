use std::fs;
use std::path::{Path, PathBuf};

/// Lines we append to <worktree>/.git/info/exclude so the per-worktree config
/// files don't show up as untracked changes in the user's git status.
const EXCLUDE_LINES: &[&str] = &[
    "# Added by Impala",
    "/.claude/settings.local.json",
];

/// Write per-worktree Claude config: <worktree>/.claude/settings.local.json
/// registers Impala hooks. Claude Code merges settings.local.json (gitignored
/// personal overrides) over settings.json automatically. The MCP server is
/// registered in ~/.claude.json by the caller, not here.
pub fn write_claude_config(worktree_path: &Path) -> Result<(), String> {
    write_claude_settings(worktree_path)?;
    add_git_excludes(worktree_path, EXCLUDE_LINES)?;
    Ok(())
}

fn write_claude_settings(worktree_path: &Path) -> Result<(), String> {
    let dir = worktree_path.join(".claude");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir .claude: {}", e))?;
    let path = dir.join("settings.local.json");
    let mut value: serde_json::Value = if path.exists() {
        let s = fs::read_to_string(&path)
            .map_err(|e| format!("read .claude/settings.local.json: {}", e))?;
        serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let hooks = value
        .as_object_mut()
        .ok_or_else(|| ".claude/settings.local.json is not an object".to_string())?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    // Hook events Claude Code recognizes. The hook command reads
    // IMPALA_HOOK_PORT and IMPALA_WORKTREE_PATH from env, so it is
    // already worktree-aware.
    let events: &[(&str, bool)] = &[
        ("UserPromptSubmit", false),
        ("Stop", false),
        ("PostToolUse", true),
        ("PostToolUseFailure", true),
        ("PermissionRequest", false),
    ];
    for (event_name, needs_matcher) in events {
        let cmd = crate::hook_server::hook_command_public(event_name);
        let event_defs = hooks
            .as_object_mut()
            .ok_or_else(|| "hooks is not an object".to_string())?
            .entry(event_name.to_string())
            .or_insert_with(|| serde_json::json!([]));
        let defs = event_defs
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{} is not an array", event_name))?;

        // Idempotent: skip if an Impala-managed hook is already there.
        let already = defs.iter().any(|def| {
            def.get("hooks")
                .and_then(|h| h.as_array())
                .map(|hs| hs.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| c.contains("IMPALA_HOOK_PORT"))
                        .unwrap_or(false)
                }))
                .unwrap_or(false)
        });
        if already { continue; }

        let mut new_def = serde_json::json!({
            "hooks": [{ "type": "command", "command": cmd }]
        });
        if *needs_matcher { new_def["matcher"] = serde_json::json!("*"); }
        defs.push(new_def);
    }
    let formatted = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("serialize .claude/settings.local.json: {}", e))?;
    fs::write(&path, formatted)
        .map_err(|e| format!("write .claude/settings.local.json: {}", e))?;
    Ok(())
}

const CODEX_EXCLUDE_LINES: &[&str] = &[
    "# Added by Impala",
    "/.impala/",
];

/// Write per-worktree Codex config under <worktree>/.impala/codex/config.toml.
/// Returns the path to use as CODEX_HOME.
pub fn write_codex_config(
    worktree_path: &Path,
    mcp_binary: &str,
) -> Result<PathBuf, String> {
    let codex_home = worktree_path.join(".impala").join("codex");
    fs::create_dir_all(&codex_home)
        .map_err(|e| format!("mkdir .impala/codex: {}", e))?;
    let config_path = codex_home.join("config.toml");

    // Build TOML manually — the schema is small and stable, and we want
    // the output to be human-readable for debugging.
    let hook_cmd = crate::hook_server::hook_command_public("PLACEHOLDER");
    let mut toml_out = String::new();
    toml_out.push_str("# Managed by Impala — regenerated on each worktree open.\n\n");

    toml_out.push_str("[mcp_servers.impala]\n");
    toml_out.push_str(&format!("command = {}\n", toml::Value::String(mcp_binary.to_string())));
    toml_out.push_str("args = []\n\n");

    let events = [
        ("user-prompt-submit", "UserPromptSubmit"),
        ("stop", "Stop"),
        ("post-tool-use", "PostToolUse"),
        ("permission-request", "PermissionRequest"),
    ];
    for (codex_event, impala_event) in events {
        let cmd = hook_cmd.replace("PLACEHOLDER", impala_event);
        toml_out.push_str("[[hooks]]\n");
        toml_out.push_str(&format!("event = {}\n", toml::Value::String(codex_event.to_string())));
        toml_out.push_str("command = \"/bin/sh\"\n");
        toml_out.push_str(&format!("args = [\"-c\", {}]\n\n", toml::Value::String(cmd)));
    }

    fs::write(&config_path, toml_out)
        .map_err(|e| format!("write codex config.toml: {}", e))?;

    // Write Codex slash command files inside CODEX_HOME. Codex reads
    // slash commands from <CODEX_HOME>/commands/*.md.
    let commands_dir = codex_home.join("commands");
    fs::create_dir_all(&commands_dir)
        .map_err(|e| format!("mkdir codex commands: {}", e))?;
    fs::write(commands_dir.join("impala-review.md"), IMPALA_REVIEW_COMMAND)
        .map_err(|e| format!("write codex impala-review.md: {}", e))?;
    fs::write(commands_dir.join("impala-plan.md"), IMPALA_PLAN_COMMAND)
        .map_err(|e| format!("write codex impala-plan.md: {}", e))?;

    add_git_excludes(worktree_path, CODEX_EXCLUDE_LINES)?;
    Ok(codex_home)
}

const IMPALA_REVIEW_COMMAND: &str = r#"---
description: Review and address code review annotations from Impala. Use when asked to review annotations, or when invoked as /impala-review.
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

For each unresolved annotation, read the file at the annotated line and evaluate the comment. Classify as ACTIONABLE, DISCUSSION, or ALREADY ADDRESSED.

## Phase 3: Address Each Annotation

Work file by file. After addressing each annotation, immediately call `mcp__impala__resolve_annotation` to mark it done.

ACTIONABLE: Fix the code, then resolve. DISCUSSION: explore codebase first; if still unclear, present options to the user, wait for their answer, apply it, then resolve. ALREADY ADDRESSED: resolve immediately.

## Phase 4: Verify

After all annotations are addressed, run the project's typecheck and lint to make sure nothing is broken.

## Phase 5: Summary

Report fixed / already addressed / discussion resolved counts and a per-file change summary.
"#;

const IMPALA_PLAN_COMMAND: &str = r#"---
description: Submit an implementation plan to Impala's Plan tab for user review, wait for the decision, and loop on annotations until approved.
argument-hint: "<plan-path>"
---

Run the full plan-review loop with Impala: register the plan, wait for the user's decision, handle annotations, loop until approved.

## Phase 1: Register

Call `mcp__impala__submit_plan_for_review` with `plan_path` (absolute path to overview.md or single task file), `title` (the feature name), and `worktree_path` (current working directory). Capture the returned `signal_path`.

## Phase 2: Wait

Start a background watcher on the signal file:

```bash
until [ -f "<signal_path>" ]; do sleep 2; done; cat "<signal_path>"
```

Tell the user the plan is submitted and end your turn. You'll be notified when the watcher fires.

## Phase 3: Handle the Decision

Call `mcp__impala__get_plan_decision`. If `approved`, stop. Otherwise: read each annotation, revise the plan in-place, call `mcp__impala__resolve_annotation` for each, then loop back to Phase 1 (auto-increments version).
"#;

/// Append entries to <worktree>/.git/info/exclude (the per-worktree
/// gitignore that does not modify the user's tracked .gitignore). No-op
/// if the worktree is not a git repository or the lines are already
/// present.
fn add_git_excludes(worktree_path: &Path, lines: &[&str]) -> Result<(), String> {
    let exclude_path: PathBuf = worktree_path.join(".git").join("info").join("exclude");
    if !exclude_path.parent().map(|p| p.exists()).unwrap_or(false) {
        return Ok(());
    }
    let existing = fs::read_to_string(&exclude_path).unwrap_or_default();
    let mut to_add: Vec<&str> = Vec::new();
    for line in lines {
        if !existing.lines().any(|l| l.trim() == *line) {
            to_add.push(line);
        }
    }
    if to_add.is_empty() { return Ok(()); }
    let mut new_content = existing;
    if !new_content.ends_with('\n') && !new_content.is_empty() {
        new_content.push('\n');
    }
    for line in to_add {
        new_content.push_str(line);
        new_content.push('\n');
    }
    fs::write(&exclude_path, new_content)
        .map_err(|e| format!("write .git/info/exclude: {}", e))?;
    Ok(())
}
