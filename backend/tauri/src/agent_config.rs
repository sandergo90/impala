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

/// Make sure <CODEX_HOME>/auth.json is a symlink to ~/.codex/auth.json so
/// `codex login` only has to happen once per machine. If a real auth.json
/// already exists in the worktree (user logged in before this code shipped),
/// migrate it up to ~/.codex first.
fn link_codex_auth(codex_home: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    let user_codex = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join(".codex");
    fs::create_dir_all(&user_codex)
        .map_err(|e| format!("mkdir ~/.codex: {}", e))?;
    let user_auth = user_codex.join("auth.json");
    let worktree_auth = codex_home.join("auth.json");

    if let Ok(meta) = worktree_auth.symlink_metadata() {
        if meta.file_type().is_symlink() {
            if fs::read_link(&worktree_auth).map(|t| t == user_auth).unwrap_or(false) {
                return Ok(());
            }
        } else if !user_auth.exists() {
            // Real file from a pre-symlink login — preserve it user-globally.
            fs::rename(&worktree_auth, &user_auth)
                .map_err(|e| format!("migrate auth.json to ~/.codex: {}", e))?;
        }
        let _ = fs::remove_file(&worktree_auth);
    }
    symlink(&user_auth, &worktree_auth)
        .map_err(|e| format!("symlink auth.json: {}", e))?;
    Ok(())
}

/// Resolve a worktree to its main repo path (the one Codex uses as the
/// project-trust key). For a regular checkout that's the worktree itself;
/// for a `git worktree`-linked checkout it's the original repo, derived by
/// reading the `.git` file's `gitdir:` line. Returns None outside a git
/// repo, in which case the caller skips the trust block.
fn main_worktree_root(worktree_path: &Path) -> Option<PathBuf> {
    let git = worktree_path.join(".git");
    if git.is_dir() {
        return Some(worktree_path.to_path_buf());
    }
    if git.is_file() {
        let content = fs::read_to_string(&git).ok()?;
        let line = content.lines().find(|l| l.starts_with("gitdir:"))?;
        // gitdir: <main>/.git/worktrees/<name> — strip <name>, then "worktrees",
        // then ".git" to land on <main>.
        let gitdir = PathBuf::from(line.trim_start_matches("gitdir:").trim());
        return gitdir.parent()?.parent()?.parent().map(|p| p.to_path_buf());
    }
    None
}

/// Read the user's ~/.codex/config.toml as the seed for a worktree config.
/// Missing file or parse failure → empty table (we still want to write a
/// usable per-worktree config; the user just loses their global settings
/// for this session, with a warning logged).
fn read_user_codex_config() -> toml::value::Table {
    let Some(path) = dirs::home_dir().map(|h| h.join(".codex").join("config.toml")) else {
        return toml::value::Table::new();
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return toml::value::Table::new();
    };
    match toml::from_str::<toml::Value>(&contents) {
        Ok(toml::Value::Table(t)) => t,
        Ok(_) => toml::value::Table::new(),
        Err(e) => {
            eprintln!("impala: failed to parse ~/.codex/config.toml: {}", e);
            toml::value::Table::new()
        }
    }
}

/// Build the merged TOML written to <CODEX_HOME>/config.toml. Starts from the
/// user's ~/.codex/config.toml so settings like `model`, `model_provider`,
/// `sandbox_mode`, custom MCP servers, etc. carry over. Then layers Impala-
/// managed sections on top:
/// - `mcp_servers.impala` — overwritten with the bundled MCP binary
/// - `projects.<repo_root>.trust_level = "trusted"` — pre-trust the repo
/// - `hooks.<Event>` — append Impala's hook handler to each event array,
///    preserving any user-defined hooks. Idempotent on the IMPALA_HOOK_PORT
///    marker so we never duplicate our own entry across runs.
fn build_codex_config(worktree_path: &Path, mcp_binary: &str) -> Result<String, String> {
    use toml::Value;
    let mut root = read_user_codex_config();

    // mcp_servers.impala — preserve siblings, overwrite our key.
    let mcp_servers = root
        .entry("mcp_servers".to_string())
        .or_insert_with(|| Value::Table(toml::value::Table::new()))
        .as_table_mut()
        .ok_or_else(|| "mcp_servers in ~/.codex/config.toml is not a table".to_string())?;
    let mut impala_mcp = toml::value::Table::new();
    impala_mcp.insert("command".into(), Value::String(mcp_binary.to_string()));
    impala_mcp.insert("args".into(), Value::Array(vec![]));
    mcp_servers.insert("impala".into(), Value::Table(impala_mcp));

    // projects.<repo_root>.trust_level — keyed by main repo path.
    if let Some(repo_root) = main_worktree_root(worktree_path) {
        let projects = root
            .entry("projects".to_string())
            .or_insert_with(|| Value::Table(toml::value::Table::new()))
            .as_table_mut()
            .ok_or_else(|| "projects in ~/.codex/config.toml is not a table".to_string())?;
        let mut trust = toml::value::Table::new();
        trust.insert("trust_level".into(), Value::String("trusted".into()));
        projects.insert(
            repo_root.to_string_lossy().to_string(),
            Value::Table(trust),
        );
    }

    // hooks.<event> — append Impala's matcher group to whatever the user has.
    // Codex hooks schema: top-level [hooks] table keyed by PascalCase event
    // name. Each event holds Vec<MatcherGroup>; each MatcherGroup holds a
    // Vec<HookHandlerConfig>. Handlers are tagged on `type`; only `command`
    // is currently useful. See codex-rs/config/src/hook_config.rs.
    let hook_cmd = crate::hook_server::hook_command_public("PLACEHOLDER");
    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Table(toml::value::Table::new()))
        .as_table_mut()
        .ok_or_else(|| "hooks in ~/.codex/config.toml is not a table".to_string())?;
    for event in ["UserPromptSubmit", "Stop", "PostToolUse", "PermissionRequest"] {
        let cmd = hook_cmd.replace("PLACEHOLDER", event);
        let arr = hooks
            .entry(event.to_string())
            .or_insert_with(|| Value::Array(vec![]))
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{} is not an array", event))?;
        let already = arr.iter().any(|g| {
            g.get("hooks")
                .and_then(|hs| hs.as_array())
                .map(|hs| hs.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| c.contains("IMPALA_HOOK_PORT"))
                        .unwrap_or(false)
                }))
                .unwrap_or(false)
        });
        if already {
            continue;
        }
        let mut handler = toml::value::Table::new();
        handler.insert("type".into(), Value::String("command".into()));
        handler.insert("command".into(), Value::String(cmd));
        let mut group = toml::value::Table::new();
        group.insert("hooks".into(), Value::Array(vec![Value::Table(handler)]));
        arr.push(Value::Table(group));
    }

    let body = toml::to_string_pretty(&Value::Table(root))
        .map_err(|e| format!("serialize codex config.toml: {}", e))?;
    Ok(format!(
        "# Managed by Impala — regenerated on each worktree open.\n\
         # Seeded from ~/.codex/config.toml so your global settings carry over.\n\
         # Impala overrides: mcp_servers.impala, projects.<repo>.trust_level, hooks.*\n\n\
         {}",
        body
    ))
}

/// Write per-worktree Codex config under <worktree>/.impala/codex/config.toml.
/// Returns the path to use as CODEX_HOME.
pub fn write_codex_config(
    worktree_path: &Path,
    mcp_binary: &str,
) -> Result<PathBuf, String> {
    let codex_home = worktree_path.join(".impala").join("codex");
    fs::create_dir_all(&codex_home)
        .map_err(|e| format!("mkdir .impala/codex: {}", e))?;

    // Symlink auth.json from ~/.codex so login persists across worktrees.
    // Without this, every worktree has its own CODEX_HOME and Codex would
    // ask the user to sign in again every time.
    link_codex_auth(&codex_home)?;

    let config_path = codex_home.join("config.toml");
    let toml_out = build_codex_config(worktree_path, mcp_binary)?;

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
