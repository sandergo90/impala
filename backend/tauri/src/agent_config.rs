use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// Lines we append to <worktree>/.git/info/exclude so the per-worktree config
/// files don't show up as untracked changes in the user's git status.
const EXCLUDE_LINES: &[&str] = &["# Added by Impala", "/.claude/settings.local.json"];

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
                .map(|hs| {
                    hs.iter().any(|h| {
                        h.get("command")
                            .and_then(|c| c.as_str())
                            .map(|c| c.contains("IMPALA_HOOK_PORT"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });
        if already {
            continue;
        }

        let mut new_def = serde_json::json!({
            "hooks": [{ "type": "command", "command": cmd }]
        });
        if *needs_matcher {
            new_def["matcher"] = serde_json::json!("*");
        }
        defs.push(new_def);
    }
    let formatted = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("serialize .claude/settings.local.json: {}", e))?;
    fs::write(&path, formatted).map_err(|e| format!("write .claude/settings.local.json: {}", e))?;
    Ok(())
}

pub(crate) const CODEX_EXCLUDE_LINES: &[&str] = &["# Added by Impala", "/.impala/"];

/// Make sure <CODEX_HOME>/auth.json is a symlink to ~/.codex/auth.json so
/// `codex login` only has to happen once per machine. If a real auth.json
/// already exists in the worktree (user logged in before this code shipped),
/// migrate it up to ~/.codex first.
fn link_codex_auth(codex_home: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    let user_codex = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join(".codex");
    fs::create_dir_all(&user_codex).map_err(|e| format!("mkdir ~/.codex: {}", e))?;
    let user_auth = user_codex.join("auth.json");
    let worktree_auth = codex_home.join("auth.json");

    if let Ok(meta) = worktree_auth.symlink_metadata() {
        if meta.file_type().is_symlink() {
            if fs::read_link(&worktree_auth)
                .map(|t| t == user_auth)
                .unwrap_or(false)
            {
                return Ok(());
            }
        } else if !user_auth.exists() {
            // Real file from a pre-symlink login — preserve it user-globally.
            fs::rename(&worktree_auth, &user_auth)
                .map_err(|e| format!("migrate auth.json to ~/.codex: {}", e))?;
        }
        let _ = fs::remove_file(&worktree_auth);
    }
    symlink(&user_auth, &worktree_auth).map_err(|e| format!("symlink auth.json: {}", e))?;
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

fn codex_hook_event_key_label(event_name: &str) -> Result<&'static str, String> {
    match event_name {
        "PreToolUse" => Ok("pre_tool_use"),
        "PermissionRequest" => Ok("permission_request"),
        "PostToolUse" => Ok("post_tool_use"),
        "PostToolUseFailure" => Ok("post_tool_use_failure"),
        "PreCompact" => Ok("pre_compact"),
        "PostCompact" => Ok("post_compact"),
        "SessionStart" => Ok("session_start"),
        "UserPromptSubmit" => Ok("user_prompt_submit"),
        "Stop" => Ok("stop"),
        other => Err(format!("unknown Codex hook event: {}", other)),
    }
}

fn sort_json_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(sort_json_value).collect())
        }
        serde_json::Value::Object(map) => {
            let mut sorted = serde_json::Map::new();
            let mut entries: Vec<_> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            for (key, value) in entries {
                sorted.insert(key, sort_json_value(value));
            }
            serde_json::Value::Object(sorted)
        }
        other => other,
    }
}

fn codex_hook_trusted_hash(event_name: &str, command: &str) -> Result<String, String> {
    use toml::Value;

    let mut handler = toml::value::Table::new();
    handler.insert("type".into(), Value::String("command".into()));
    handler.insert("command".into(), Value::String(command.to_string()));
    handler.insert("timeout".into(), Value::Integer(600));
    handler.insert("async".into(), Value::Boolean(false));

    let mut identity = toml::value::Table::new();
    identity.insert(
        "event_name".into(),
        Value::String(codex_hook_event_key_label(event_name)?.to_string()),
    );
    identity.insert("hooks".into(), Value::Array(vec![Value::Table(handler)]));

    let json = serde_json::to_value(Value::Table(identity))
        .map_err(|e| format!("serialize hook identity: {}", e))?;
    let canonical = sort_json_value(json);
    let bytes = serde_json::to_vec(&canonical)
        .map_err(|e| format!("serialize hook identity json: {}", e))?;
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
    Ok(format!("sha256:{}", hex))
}

fn codex_config_key_source(config_path: &Path) -> PathBuf {
    match config_path
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
    {
        Some(parent) => parent.join(
            config_path
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("config.toml")),
        ),
        None => config_path.to_path_buf(),
    }
}

fn codex_hook_trust_key(
    hook_source_path: &Path,
    event_name: &str,
    group_index: usize,
) -> Result<String, String> {
    Ok(format!(
        "{}:{}:{}:0",
        codex_config_key_source(hook_source_path).to_string_lossy(),
        codex_hook_event_key_label(event_name)?,
        group_index,
    ))
}

fn trust_codex_hook(
    hooks: &mut toml::value::Table,
    hook_source_path: &Path,
    event_name: &str,
    group_index: usize,
    command: &str,
) -> Result<(), String> {
    use toml::Value;

    let state = hooks
        .entry("state".to_string())
        .or_insert_with(|| Value::Table(toml::value::Table::new()))
        .as_table_mut()
        .ok_or_else(|| "hooks.state in ~/.codex/config.toml is not a table".to_string())?;
    let key = codex_hook_trust_key(hook_source_path, event_name, group_index)?;
    let mut trust = toml::value::Table::new();
    trust.insert(
        "trusted_hash".into(),
        Value::String(codex_hook_trusted_hash(event_name, command)?),
    );
    state.insert(key, Value::Table(trust));
    Ok(())
}

fn upsert_codex_mcp_server(
    root: &mut toml::value::Table,
    mcp_binary: &str,
) -> Result<(), String> {
    use toml::Value;

    let mcp_servers = root
        .entry("mcp_servers".to_string())
        .or_insert_with(|| Value::Table(toml::value::Table::new()))
        .as_table_mut()
        .ok_or_else(|| "mcp_servers in ~/.codex/config.toml is not a table".to_string())?;
    let mut impala_mcp = toml::value::Table::new();
    impala_mcp.insert("command".into(), Value::String(mcp_binary.to_string()));
    impala_mcp.insert("args".into(), Value::Array(vec![]));
    mcp_servers.insert("impala".into(), Value::Table(impala_mcp));

    Ok(())
}

fn write_codex_commands(codex_home: &Path) -> Result<(), String> {
    let commands_dir = codex_home.join("commands");
    fs::create_dir_all(&commands_dir).map_err(|e| format!("mkdir codex commands: {}", e))?;
    fs::write(commands_dir.join("impala-review.md"), IMPALA_REVIEW_COMMAND)
        .map_err(|e| format!("write codex impala-review.md: {}", e))?;

    Ok(())
}

fn write_user_codex_config(
    registrations: &[CodexHookRegistration],
    mcp_binary: &str,
) -> Result<(), String> {
    use toml::Value;

    let user_codex = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join(".codex");
    fs::create_dir_all(&user_codex).map_err(|e| format!("mkdir ~/.codex: {}", e))?;
    write_codex_commands(&user_codex)?;

    let config_path = user_codex.join("config.toml");
    let mut root = if config_path.exists() {
        let contents =
            fs::read_to_string(&config_path).map_err(|e| format!("read config.toml: {}", e))?;
        match toml::from_str::<toml::Value>(&contents) {
            Ok(Value::Table(table)) => table,
            Ok(_) => toml::value::Table::new(),
            Err(e) => return Err(format!("parse ~/.codex/config.toml: {}", e)),
        }
    } else {
        toml::value::Table::new()
    };

    upsert_codex_mcp_server(&mut root, mcp_binary)?;

    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Table(toml::value::Table::new()))
        .as_table_mut()
        .ok_or_else(|| "hooks in ~/.codex/config.toml is not a table".to_string())?;

    for registration in registrations {
        trust_codex_hook(
            hooks,
            &registration.source_path,
            &registration.event_name,
            registration.group_index,
            &registration.command,
        )?;
    }

    let body = toml::to_string_pretty(&Value::Table(root))
        .map_err(|e| format!("serialize config.toml: {}", e))?;
    fs::write(&config_path, body).map_err(|e| format!("write config.toml: {}", e))?;

    Ok(())
}

struct CodexHookRegistration {
    event_name: String,
    group_index: usize,
    command: String,
    source_path: PathBuf,
}

fn ensure_user_codex_hooks() -> Result<Vec<CodexHookRegistration>, String> {
    let user_codex = dirs::home_dir()
        .ok_or_else(|| "no home dir".to_string())?
        .join(".codex");
    ensure_codex_hooks_in(&user_codex)
}

/// Write/merge Impala's status hooks into <codex_dir>/hooks.json, returning
/// registrations keyed to that file.
fn ensure_codex_hooks_in(codex_dir: &Path) -> Result<Vec<CodexHookRegistration>, String> {
    fs::create_dir_all(codex_dir)
        .map_err(|e| format!("mkdir {}: {}", codex_dir.display(), e))?;

    let hooks_path = codex_dir.join("hooks.json");
    let mut root: serde_json::Value = if hooks_path.exists() {
        let contents =
            fs::read_to_string(&hooks_path).map_err(|e| format!("read hooks.json: {}", e))?;
        serde_json::from_str(&contents).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !root.is_object() {
        root = serde_json::json!({});
    }
    let hooks = root
        .as_object_mut()
        .expect("root was normalized to object")
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks = hooks
        .as_object_mut()
        .expect("hooks was normalized to object");

    let mut registrations = Vec::new();
    for event_name in [
        "UserPromptSubmit",
        "Stop",
        "PostToolUse",
        "PostToolUseFailure",
        "PermissionRequest",
    ] {
        let cmd = crate::hook_server::hook_command_public(event_name);
        let groups = hooks
            .entry(event_name.to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !groups.is_array() {
            *groups = serde_json::json!([]);
        }
        let groups = groups
            .as_array_mut()
            .expect("event hooks was normalized to array");

        let existing_index = groups.iter().position(|group| {
            group
                .get("hooks")
                .and_then(|hs| hs.as_array())
                .map(|hs| {
                    hs.iter().any(|hook| {
                        hook.get("command")
                            .and_then(|c| c.as_str())
                            .map(|c| c.contains("IMPALA_HOOK_PORT"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });

        let group_index = match existing_index {
            Some(index) => index,
            None => {
                let index = groups.len();
                groups.push(serde_json::json!({
                    "hooks": [{ "type": "command", "command": cmd }]
                }));
                index
            }
        };

        registrations.push(CodexHookRegistration {
            event_name: event_name.to_string(),
            group_index,
            command: cmd,
            source_path: hooks_path.clone(),
        });
    }

    let formatted =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize hooks.json: {}", e))?;
    fs::write(&hooks_path, formatted).map_err(|e| format!("write hooks.json: {}", e))?;

    Ok(registrations)
}

/// Build the merged TOML written to <CODEX_HOME>/config.toml. Starts from the
/// user's ~/.codex/config.toml so settings like `model`, `model_provider`,
/// `sandbox_mode`, custom MCP servers, etc. carry over. Then layers Impala-
/// managed sections on top:
/// - `mcp_servers.impala` — overwritten with the bundled MCP binary
/// - `projects.<repo_root>.trust_level = "trusted"` — pre-trust the repo
/// - `hooks.state` — trusts the Impala handlers written to ~/.codex/hooks.json.
fn build_codex_config(
    worktree_path: &Path,
    mcp_binary: &str,
    hook_registrations: &[CodexHookRegistration],
) -> Result<String, String> {
    use toml::Value;
    let mut root = read_user_codex_config();

    // mcp_servers.impala — preserve siblings, overwrite our key.
    upsert_codex_mcp_server(&mut root, mcp_binary)?;

    // projects.<repo_root>.trust_level — keyed by main repo path.
    if let Some(repo_root) = main_worktree_root(worktree_path) {
        let projects = root
            .entry("projects".to_string())
            .or_insert_with(|| Value::Table(toml::value::Table::new()))
            .as_table_mut()
            .ok_or_else(|| "projects in ~/.codex/config.toml is not a table".to_string())?;
        let mut trust = toml::value::Table::new();
        trust.insert("trust_level".into(), Value::String("trusted".into()));
        projects.insert(repo_root.to_string_lossy().to_string(), Value::Table(trust));
    }

    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Table(toml::value::Table::new()))
        .as_table_mut()
        .ok_or_else(|| "hooks in ~/.codex/config.toml is not a table".to_string())?;
    // Seeded ~/.codex trust keys a hooks.json Codex won't load here; re-trust ours below.
    hooks.remove("state");
    for registration in hook_registrations {
        trust_codex_hook(
            hooks,
            &registration.source_path,
            &registration.event_name,
            registration.group_index,
            &registration.command,
        )?;
    }

    let body = toml::to_string_pretty(&Value::Table(root))
        .map_err(|e| format!("serialize codex config.toml: {}", e))?;
    Ok(format!(
        "# Managed by Impala — regenerated on each worktree open.\n\
         # Seeded from ~/.codex/config.toml so your global settings carry over.\n\
         # Impala overrides: mcp_servers.impala, projects.<repo>.trust_level, hooks.state\n\n\
         {}",
        body
    ))
}

/// Write per-worktree Codex config under <worktree>/.impala/codex/config.toml.
/// Returns the path to use as CODEX_HOME.
pub fn write_codex_config(worktree_path: &Path, mcp_binary: &str) -> Result<PathBuf, String> {
    let codex_home = worktree_path.join(".impala").join("codex");
    fs::create_dir_all(&codex_home).map_err(|e| format!("mkdir .impala/codex: {}", e))?;

    // Symlink auth.json from ~/.codex so login persists across worktrees.
    // Without this, every worktree has its own CODEX_HOME and Codex would
    // ask the user to sign in again every time.
    link_codex_auth(&codex_home)?;

    let config_path = codex_home.join("config.toml");
    // Codex loads hooks from <CODEX_HOME>/hooks.json, so write+trust them there too.
    let user_registrations = ensure_user_codex_hooks()?;
    write_user_codex_config(&user_registrations, mcp_binary)?;
    let worktree_registrations = ensure_codex_hooks_in(&codex_home)?;
    let toml_out = build_codex_config(worktree_path, mcp_binary, &worktree_registrations)?;

    fs::write(&config_path, toml_out).map_err(|e| format!("write codex config.toml: {}", e))?;

    // Write Codex slash command files inside CODEX_HOME. Codex reads
    // slash commands from <CODEX_HOME>/commands/*.md.
    write_codex_commands(&codex_home)?;

    crate::issue_context::ensure_codex_context(worktree_path)?;

    add_git_excludes(worktree_path, CODEX_EXCLUDE_LINES)?;
    Ok(codex_home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_hook_hash_matches_codex_current_hash() {
        assert_eq!(
            codex_hook_trusted_hash("UserPromptSubmit", "echo hi").unwrap(),
            "sha256:4ac11110e7e52a7ace4a63994f6a554e0c891264e3e3733d1f0541b1cd0b3b3e"
        );
        assert_eq!(
            codex_hook_trusted_hash("PostToolUse", "echo hi").unwrap(),
            "sha256:5130c1496a4cf303e70321c56c8c8829a88cf2cd8cda2e4f61079877fc54e834"
        );
        assert_eq!(
            codex_hook_trusted_hash("PermissionRequest", "echo hi").unwrap(),
            "sha256:627d5479bfc3fc09415e10ece2e91756f584fcc0076ca6e31e55cd0bab0090b5"
        );
    }

    #[test]
    fn codex_config_key_source_canonicalizes_parent() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");

        assert_eq!(
            codex_config_key_source(&config_path),
            fs::canonicalize(dir.path()).unwrap().join("config.toml")
        );
    }

    #[test]
    fn codex_hook_event_label_supports_all_registered_events() {
        for event_name in [
            "UserPromptSubmit",
            "Stop",
            "PostToolUse",
            "PostToolUseFailure",
            "PermissionRequest",
        ] {
            codex_hook_event_key_label(event_name).unwrap();
        }
    }

    #[test]
    fn upsert_codex_mcp_server_preserves_other_servers() {
        use toml::Value;

        let mut root = toml::value::Table::new();
        let mut mcp_servers = toml::value::Table::new();
        let mut other = toml::value::Table::new();
        other.insert("command".into(), Value::String("other-mcp".into()));
        mcp_servers.insert("other".into(), Value::Table(other));
        root.insert("mcp_servers".into(), Value::Table(mcp_servers));

        upsert_codex_mcp_server(&mut root, "/Applications/Impala.app/impala-mcp").unwrap();

        let servers = root.get("mcp_servers").unwrap().as_table().unwrap();
        assert!(servers.contains_key("other"));
        assert_eq!(
            servers
                .get("impala")
                .and_then(|server| server.get("command"))
                .and_then(|command| command.as_str()),
            Some("/Applications/Impala.app/impala-mcp")
        );
    }
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

/// Append entries to <worktree>/.git/info/exclude (the per-worktree
/// gitignore that does not modify the user's tracked .gitignore). No-op
/// if the worktree is not a git repository or the lines are already
/// present.
pub(crate) fn add_git_excludes(worktree_path: &Path, lines: &[&str]) -> Result<(), String> {
    let Some(exclude_path) = git_exclude_path(worktree_path) else {
        return Ok(());
    };

    let existing = fs::read_to_string(&exclude_path).unwrap_or_default();
    let mut to_add: Vec<&str> = Vec::new();
    for line in lines {
        if !existing.lines().any(|l| l.trim() == *line) {
            to_add.push(line);
        }
    }
    if to_add.is_empty() {
        return Ok(());
    }
    let mut new_content = existing;
    if !new_content.ends_with('\n') && !new_content.is_empty() {
        new_content.push('\n');
    }
    for line in to_add {
        new_content.push_str(line);
        new_content.push('\n');
    }
    fs::write(&exclude_path, new_content).map_err(|e| format!("write .git/info/exclude: {}", e))?;
    Ok(())
}

fn git_exclude_path(worktree_path: &Path) -> Option<PathBuf> {
    let git = worktree_path.join(".git");
    if git.is_dir() {
        let exclude_path = git.join("info").join("exclude");
        return exclude_path
            .parent()
            .map(|p| p.exists())
            .unwrap_or(false)
            .then_some(exclude_path);
    }

    if git.is_file() {
        let content = fs::read_to_string(&git).ok()?;
        let line = content.lines().find(|l| l.starts_with("gitdir:"))?;
        let raw = PathBuf::from(line.trim_start_matches("gitdir:").trim());
        let gitdir = if raw.is_absolute() {
            raw
        } else {
            worktree_path.join(raw)
        };
        let exclude_path = gitdir.join("info").join("exclude");
        return exclude_path
            .parent()
            .map(|p| p.exists())
            .unwrap_or(false)
            .then_some(exclude_path);
    }

    None
}
