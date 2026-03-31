use crate::linear;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

const START_MARKER: &str = "<!-- DIFFER:LINEAR_CONTEXT:START -->";
const END_MARKER: &str = "<!-- DIFFER:LINEAR_CONTEXT:END -->";
const REFRESH_INTERVAL: Duration = Duration::from_secs(300); // 5 minutes

/// Resolve the CLAUDE.md path for a worktree.
/// Claude Code uses `~/.claude/projects/<encoded-path>/CLAUDE.md`
/// where the path is encoded by replacing `/` with `-`.
fn claude_md_path(worktree_path: &str) -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let encoded = worktree_path.replace('/', "-");
    Ok(home
        .join(".claude")
        .join("projects")
        .join(&encoded)
        .join("CLAUDE.md"))
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
    let path = claude_md_path(worktree_path)?;

    // Rate-limit: skip if file was recently updated (unless forced)
    if !force {
        if let Ok(metadata) = fs::metadata(&path) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(elapsed) = SystemTime::now().duration_since(modified) {
                    if elapsed < REFRESH_INTERVAL {
                        return Ok(());
                    }
                }
            }
        }
    }

    let detail = linear::get_issue_detail(api_key, issue_id)?;
    let section = format_section(&detail);

    let existing = fs::read_to_string(&path).unwrap_or_default();
    let content = if existing.is_empty() {
        format!("{}\n", section)
    } else {
        splice_section(&existing, &section)
    };

    if content == existing {
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write CLAUDE.md: {}", e))?;

    Ok(())
}

/// Remove Linear context section from CLAUDE.md. Cleans up empty files/dirs.
pub fn clean_context(worktree_path: &str) -> Result<(), String> {
    let path = claude_md_path(worktree_path)?;

    if !path.exists() {
        return Ok(());
    }

    let existing =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read CLAUDE.md: {}", e))?;

    let remaining = remove_section(&existing);

    if remaining.trim().is_empty() {
        // File is empty — delete it
        fs::remove_file(&path).map_err(|e| format!("Failed to delete CLAUDE.md: {}", e))?;
        // Try to remove parent dir if empty (best-effort)
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir(parent); // fails silently if not empty
        }
    } else {
        fs::write(&path, remaining).map_err(|e| format!("Failed to write CLAUDE.md: {}", e))?;
    }

    Ok(())
}
