use std::fs;
use std::path::{Path, PathBuf};

/// Lines we append to <worktree>/.git/info/exclude so the per-worktree config
/// files don't show up as untracked changes in the user's git status.
const EXCLUDE_LINES: &[&str] = &[
    "# Added by Impala",
    "/.claude/",
    "/.mcp.json",
];

/// Write per-worktree Claude config: <worktree>/.mcp.json registers the
/// impala MCP server, <worktree>/.claude/settings.json registers Impala
/// hooks. Both are auto-discovered by Claude Code when cwd is in the
/// worktree.
pub fn write_claude_config(
    worktree_path: &Path,
    mcp_binary: &str,
) -> Result<(), String> {
    write_mcp_json(worktree_path, mcp_binary)?;
    write_claude_settings(worktree_path)?;
    add_git_excludes(worktree_path, EXCLUDE_LINES)?;
    Ok(())
}

fn write_mcp_json(worktree_path: &Path, mcp_binary: &str) -> Result<(), String> {
    let path = worktree_path.join(".mcp.json");
    let mut value: serde_json::Value = if path.exists() {
        let s = fs::read_to_string(&path)
            .map_err(|e| format!("read .mcp.json: {}", e))?;
        serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let servers = value
        .as_object_mut()
        .ok_or_else(|| ".mcp.json is not an object".to_string())?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    servers
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not an object".to_string())?
        .insert(
            "impala".to_string(),
            serde_json::json!({ "command": mcp_binary, "args": [] }),
        );
    let formatted = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("serialize .mcp.json: {}", e))?;
    fs::write(&path, formatted).map_err(|e| format!("write .mcp.json: {}", e))?;
    Ok(())
}

fn write_claude_settings(worktree_path: &Path) -> Result<(), String> {
    let dir = worktree_path.join(".claude");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir .claude: {}", e))?;
    let path = dir.join("settings.json");
    let mut value: serde_json::Value = if path.exists() {
        let s = fs::read_to_string(&path)
            .map_err(|e| format!("read .claude/settings.json: {}", e))?;
        serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let hooks = value
        .as_object_mut()
        .ok_or_else(|| ".claude/settings.json is not an object".to_string())?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    // Same events + matchers as hook_server::install_claude_hooks used to
    // install globally. The hook command itself reads IMPALA_HOOK_PORT and
    // IMPALA_WORKTREE_PATH from env, so it's already worktree-aware.
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
        .map_err(|e| format!("serialize .claude/settings.json: {}", e))?;
    fs::write(&path, formatted)
        .map_err(|e| format!("write .claude/settings.json: {}", e))?;
    Ok(())
}

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
