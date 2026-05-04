use crate::linear;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

const START_MARKER: &str = "<!-- IMPALA:LINEAR_CONTEXT:START -->";
const END_MARKER: &str = "<!-- IMPALA:LINEAR_CONTEXT:END -->";
const REFRESH_INTERVAL: Duration = Duration::from_secs(300); // 5 minutes

/// Resolve the CLAUDE.local.md path for a worktree.
/// Claude Code walks up the directory tree from CWD and reads CLAUDE.local.md files.
/// Writing directly into the worktree directory is the simplest approach —
/// it's gitignored, per-worktree, and automatically discovered by Claude Code.
fn claude_context_path(worktree_path: &str) -> PathBuf {
    PathBuf::from(worktree_path).join("CLAUDE.local.md")
}

/// Resolve the per-worktree Codex AGENTS.md path.
/// Impala launches Codex with CODEX_HOME=<worktree>/.impala/codex, and Codex
/// reads AGENTS.md from CODEX_HOME in addition to project AGENTS.md files.
fn codex_context_path(worktree_path: &str) -> PathBuf {
    PathBuf::from(worktree_path)
        .join(".impala")
        .join("codex")
        .join("AGENTS.md")
}

fn user_codex_agents_content() -> String {
    dirs::home_dir()
        .map(|home| home.join(".codex").join("AGENTS.md"))
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_default()
}

fn read_codex_agents_base(path: &std::path::Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|_| user_codex_agents_content())
}

/// Ensure the per-worktree Codex AGENTS.md exists, seeded with the user's
/// global Codex instructions when present. Existing files are left untouched so
/// Linear context written before Codex launch is preserved.
pub fn ensure_codex_context(worktree_path: &std::path::Path) -> Result<(), String> {
    let path = codex_context_path(worktree_path.to_string_lossy().as_ref());
    if path.exists() {
        return Ok(());
    }

    let content = user_codex_agents_content();
    if content.is_empty() {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir codex context dir: {}", e))?;
    }
    fs::write(&path, content).map_err(|e| format!("write codex AGENTS.md: {}", e))?;
    Ok(())
}

fn write_marked_section(path: PathBuf, existing: String, section: &str) -> Result<(), String> {
    let content = if existing.is_empty() {
        format!("{}\n", section)
    } else {
        splice_section(&existing, section)
    };

    if content == existing {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir context dir: {}", e))?;
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write context file: {}", e))?;

    Ok(())
}

fn clean_marked_section(path: PathBuf) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let existing =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read context file: {}", e))?;

    let remaining = remove_section(&existing);

    if remaining.trim().is_empty() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete context file: {}", e))?;
    } else {
        fs::write(&path, remaining).map_err(|e| format!("Failed to write context file: {}", e))?;
    }

    Ok(())
}

fn claude_md_path(worktree_path: &str) -> Result<PathBuf, String> {
    Ok(claude_context_path(worktree_path))
}

/// Format issue detail as a markdown section between markers.
fn format_section(detail: &linear::LinearIssueDetail) -> String {
    let mut s = String::new();
    s.push_str(START_MARKER);
    s.push_str("\n# Linear Issue Context\n\n");
    s.push_str(&format!("**[{}] {}**\n", detail.identifier, detail.title));
    s.push_str(&format!("Status: {}\n", detail.status));
    s.push_str(&format!("URL: {}\n", detail.url));

    if let Some(desc) = &detail.description {
        if !desc.trim().is_empty() {
            s.push_str("\n## Description\n\n");
            s.push_str(desc.trim());
            s.push('\n');
        }
    }

    if !detail.comments.is_empty() {
        s.push_str("\n## Comments\n");
        for comment in &detail.comments {
            // Extract date portion from ISO timestamp
            let date = comment
                .created_at
                .split('T')
                .next()
                .unwrap_or(&comment.created_at);
            s.push_str(&format!("\n**{}** ({}):\n", comment.author, date));
            s.push_str(comment.body.trim());
            s.push('\n');
        }
    }

    s.push_str(END_MARKER);
    s
}

/// Replace content between markers in existing file content, or append.
fn splice_section(existing: &str, section: &str) -> String {
    if let (Some(start_pos), Some(end_pos)) =
        (existing.find(START_MARKER), existing.find(END_MARKER))
    {
        let end_pos = end_pos + END_MARKER.len();
        let mut result = String::new();
        result.push_str(&existing[..start_pos]);
        result.push_str(section);
        result.push_str(&existing[end_pos..]);
        result
    } else {
        // No existing markers — append
        let mut result = existing.to_string();
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(section);
        result.push('\n');
        result
    }
}

/// Remove content between markers (inclusive). Returns remaining content.
fn remove_section(existing: &str) -> String {
    if let (Some(start_pos), Some(end_pos)) =
        (existing.find(START_MARKER), existing.find(END_MARKER))
    {
        let end_pos = end_pos + END_MARKER.len();
        let mut result = String::new();
        result.push_str(&existing[..start_pos]);
        let after = &existing[end_pos..];
        // Clean up extra newlines at the splice point
        result.push_str(after.trim_start_matches('\n'));
        result
    } else {
        existing.to_string()
    }
}

/// Write Linear issue context to CLAUDE.md for a worktree.
/// If `force` is false, skips if file was updated within REFRESH_INTERVAL.
pub fn write_context(
    api_key: &str,
    issue_id: &str,
    worktree_path: &str,
    force: bool,
) -> Result<(), String> {
    let claude_path = claude_md_path(worktree_path)?;
    let codex_path = codex_context_path(worktree_path);

    // Rate-limit: skip if file was recently updated (unless forced)
    if !force {
        let codex_has_context = fs::read_to_string(&codex_path)
            .map(|content| content.contains(START_MARKER))
            .unwrap_or(false);
        if codex_has_context {
            if let Ok(metadata) = fs::metadata(&claude_path) {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(elapsed) = SystemTime::now().duration_since(modified) {
                        if elapsed < REFRESH_INTERVAL {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    let detail = linear::get_issue_detail(api_key, issue_id)?;
    let section = format_section(&detail);

    let claude_existing = fs::read_to_string(&claude_path).unwrap_or_default();
    write_marked_section(claude_path, claude_existing, &section)?;

    let codex_existing = read_codex_agents_base(&codex_path);
    crate::agent_config::add_git_excludes(
        std::path::Path::new(worktree_path),
        crate::agent_config::CODEX_EXCLUDE_LINES,
    )?;
    write_marked_section(codex_path, codex_existing, &section)?;

    Ok(())
}

/// Remove Linear context from Claude and Codex context files. Deletes files
/// that become empty after removing the managed section.
pub fn clean_context(worktree_path: &str) -> Result<(), String> {
    clean_marked_section(claude_md_path(worktree_path)?)?;
    clean_marked_section(codex_context_path(worktree_path))?;

    Ok(())
}
