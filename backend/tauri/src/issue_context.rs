use crate::issue_tracker::{IssueDetail, IssueTracker};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const REFRESH_INTERVAL: Duration = Duration::from_secs(300); // 5 minutes

/// Path to the Issue context file inside a worktree:
/// `<worktree>/docs/issues/<IDENTIFIER>.md`. The agent is pointed at this
/// path on first launch via an `@`-mention so the issue context is loaded
/// on demand instead of stuffed into CLAUDE.local.md / AGENTS.md.
fn issue_doc_path(worktree_path: &str, identifier: &str) -> PathBuf {
    PathBuf::from(worktree_path)
        .join("docs")
        .join("issues")
        .join(format!("{identifier}.md"))
}

fn user_codex_agents_content() -> String {
    dirs::home_dir()
        .map(|home| home.join(".codex").join("AGENTS.md"))
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_default()
}

/// Ensure the per-worktree Codex AGENTS.md exists, seeded with the user's
/// global Codex instructions when present. Existing files are left untouched.
/// Codex reads <CODEX_HOME>/AGENTS.md when CODEX_HOME points at the worktree,
/// so without this seeding the user loses their global Codex instructions.
pub fn ensure_codex_context(worktree_path: &Path) -> Result<(), String> {
    let path = worktree_path
        .join(".impala")
        .join("codex")
        .join("AGENTS.md");
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

/// Render the issue body written to docs/issues/<IDENTIFIER>.md. Provider-
/// neutral: the detail is already normalized (Jira's ADF is converted to
/// markdown before it reaches here).
fn format_issue(detail: &IssueDetail) -> String {
    let mut s = String::new();
    s.push_str("# Issue Context\n\n");
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

    s
}

/// Write Issue context to <worktree>/docs/issues/<IDENTIFIER>.md using the
/// project's resolved tracker. If `force` is false, skips when the file was
/// updated within REFRESH_INTERVAL.
pub fn write_context(
    tracker: &dyn IssueTracker,
    issue_id: &str,
    worktree_path: &str,
    force: bool,
) -> Result<(), String> {
    let detail = tracker.issue_detail(issue_id)?;
    let path = issue_doc_path(worktree_path, &detail.identifier);

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

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir docs/issues dir: {}", e))?;
    }
    fs::write(&path, format_issue(&detail))
        .map_err(|e| format!("Failed to write issue context file: {}", e))?;

    Ok(())
}
