use serde::Serialize;
use std::process::Command;
use std::time::SystemTime;

#[derive(Debug, Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub head_commit: String,
    pub title: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
    pub additions: i32,
    pub deletions: i32,
}

#[derive(Debug, Serialize)]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
}

pub(crate) fn augmented_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let extras = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
    let mut parts: Vec<&str> = current.split(':').collect();
    for dir in extras {
        if !parts.contains(&dir) {
            parts.push(dir);
        }
    }
    parts.join(":")
}

fn run_git(worktree_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .env("PATH", augmented_path())
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

pub fn list_worktrees(repo_path: &str) -> Result<Vec<Worktree>, String> {
    let output = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = Vec::new();
    let mut path = String::new();
    let mut branch = String::new();
    let mut head = String::new();

    let flush = |path: &mut String, branch: &mut String, head: &mut String, worktrees: &mut Vec<Worktree>| {
        if !path.is_empty() {
            worktrees.push(Worktree {
                path: std::mem::take(path),
                branch: if branch.is_empty() {
                    "HEAD (detached)".to_string()
                } else {
                    std::mem::take(branch)
                },
                head_commit: std::mem::take(head),
                title: None,
            });
        }
    };

    for line in output.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = p.to_string();
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        } else if line.is_empty() {
            flush(&mut path, &mut branch, &mut head, &mut worktrees);
        }
    }
    flush(&mut path, &mut branch, &mut head, &mut worktrees);

    // Filter out temporary Claude Code agent worktrees
    worktrees.retain(|wt| !wt.branch.starts_with("worktree-agent-"));

    // Sort newest-created first; worktrees without a readable creation time sink to the bottom.
    worktrees.sort_by(|a, b| worktree_created_at(&b.path).cmp(&worktree_created_at(&a.path)));

    Ok(worktrees)
}

fn worktree_created_at(path: &str) -> Option<SystemTime> {
    let meta = std::fs::metadata(path).ok()?;
    meta.created().or_else(|_| meta.modified()).ok()
}

pub fn detect_base_branch(worktree_path: &str) -> Result<String, String> {
    // Prefer remote tracking branches for accurate comparison (local branches may be stale)
    for branch in &["origin/develop", "origin/main", "origin/master"] {
        let result = run_git(worktree_path, &["rev-parse", "--verify", branch]);
        if result.is_ok() {
            return Ok(branch.to_string());
        }
    }
    // Fall back to local branches
    for branch in &["develop", "main", "master"] {
        let result = run_git(worktree_path, &["rev-parse", "--verify", branch]);
        if result.is_ok() {
            return Ok(branch.to_string());
        }
    }

    let remote_head = run_git(worktree_path, &["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if let Ok(ref_str) = remote_head {
        let branch = ref_str
            .trim()
            .strip_prefix("refs/remotes/origin/")
            .unwrap_or(ref_str.trim())
            .to_string();
        return Ok(branch);
    }

    let first_commit = run_git(worktree_path, &["rev-list", "--max-parents=0", "HEAD"])?;
    Ok(first_commit.trim().to_string())
}

pub fn get_diverged_commits(
    worktree_path: &str,
    base_branch: Option<String>,
) -> Result<Vec<CommitInfo>, String> {
    let base = match base_branch {
        Some(b) => b,
        None => detect_base_branch(worktree_path)?,
    };

    let range = format!("{}..HEAD", base);
    let output = run_git(
        worktree_path,
        &["log", &range, "--shortstat", "--format=%H%n%s%n%an%n%aI"],
    )?;

    let mut commits = Vec::new();
    let mut lines = output.lines().peekable();

    while lines.peek().is_some() {
        // Skip empty lines
        while lines.peek() == Some(&"") {
            lines.next();
        }

        let hash = match lines.next() {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => break,
        };
        let message = lines.next().unwrap_or("").to_string();
        let author = lines.next().unwrap_or("").to_string();
        let date = lines.next().unwrap_or("").to_string();

        // Next non-empty line is the shortstat (e.g., " 3 files changed, 10 insertions(+), 2 deletions(-)")
        let mut additions = 0i32;
        let mut deletions = 0i32;
        while let Some(line) = lines.peek() {
            if line.is_empty() {
                lines.next();
                continue;
            }
            if line.contains("changed") {
                let stat_line = lines.next().unwrap_or("");
                for part in stat_line.split(',') {
                    let part = part.trim();
                    if part.contains("insertion") {
                        additions = part.split_whitespace().next().unwrap_or("0").parse().unwrap_or(0);
                    } else if part.contains("deletion") {
                        deletions = part.split_whitespace().next().unwrap_or("0").parse().unwrap_or(0);
                    }
                }
                break;
            }
            break;
        }

        commits.push(CommitInfo {
            hash,
            message,
            author,
            date,
            additions,
            deletions,
        });
    }

    Ok(commits)
}

pub fn get_changed_files(
    worktree_path: &str,
    commit_hash: &str,
) -> Result<Vec<ChangedFile>, String> {
    let output = run_git(
        worktree_path,
        &["diff-tree", "--no-commit-id", "-r", "--name-status", commit_hash],
    )?;

    let files = output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.splitn(2, '\t');
            let status = parts.next().unwrap_or("?").to_string();
            let path = parts.next().unwrap_or("").to_string();
            ChangedFile { status, path }
        })
        .collect();

    Ok(files)
}

pub fn get_commit_diff(
    worktree_path: &str,
    commit_hash: &str,
    file_path: &str,
) -> Result<String, String> {
    let range = format!("{}~1..{}", commit_hash, commit_hash);
    run_git(worktree_path, &["diff", &range, "--", file_path])
}

pub fn get_full_commit_diff(
    worktree_path: &str,
    commit_hash: &str,
) -> Result<String, String> {
    let range = format!("{}~1..{}", commit_hash, commit_hash);
    run_git(worktree_path, &["diff", &range])
}

pub fn get_branch_diff(worktree_path: &str, file_path: &str) -> Result<String, String> {
    let base = detect_base_branch(worktree_path)?;
    let range = format!("{}...HEAD", base);
    run_git(worktree_path, &["diff", &range, "--", file_path])
}

pub fn get_full_branch_diff(worktree_path: &str) -> Result<String, String> {
    let base = detect_base_branch(worktree_path)?;
    let range = format!("{}...HEAD", base);
    run_git(worktree_path, &["diff", &range])
}

pub fn get_file_at_ref(worktree_path: &str, git_ref: &str, file_path: &str) -> Result<String, String> {
    let spec = format!("{}:{}", git_ref, file_path);
    run_git(worktree_path, &["show", &spec])
}

pub fn get_file_diff_since_commit(
    worktree_path: &str,
    since_commit: &str,
    file_path: &str,
) -> Result<String, String> {
    let range = format!("{}..HEAD", since_commit);
    run_git(worktree_path, &["diff", &range, "--", file_path])
}

pub fn discard_file_changes(worktree_path: &str, file_path: &str) -> Result<(), String> {
    let tracked = run_git(
        worktree_path,
        &["ls-files", "--error-unmatch", "--", file_path],
    )
    .is_ok();

    if tracked {
        run_git(
            worktree_path,
            &["restore", "--source=HEAD", "--staged", "--worktree", "--", file_path],
        )?;
    } else {
        let full_path = std::path::Path::new(worktree_path).join(file_path);
        if full_path.exists() {
            std::fs::remove_file(&full_path)
                .map_err(|e| format!("Failed to remove {}: {}", file_path, e))?;
        }
    }
    Ok(())
}

pub fn get_uncommitted_files(worktree_path: &str) -> Result<Vec<ChangedFile>, String> {
    let output = run_git(worktree_path, &["status", "--porcelain", "-uall"])?;
    let files = output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let status = line[..2].trim().to_string();
            let path = line[3..].to_string();
            ChangedFile { status, path }
        })
        .collect();
    Ok(files)
}

pub fn get_uncommitted_diff(worktree_path: &str) -> Result<String, String> {
    // Get both staged and unstaged changes
    let unstaged = run_git(worktree_path, &["diff"]).unwrap_or_default();
    let staged = run_git(worktree_path, &["diff", "--cached"]).unwrap_or_default();

    // Generate diffs for untracked files (git diff doesn't include them)
    let status = run_git(worktree_path, &["status", "--porcelain", "-uall"]).unwrap_or_default();
    let mut untracked_diffs = String::new();
    for line in status.lines() {
        if line.starts_with("??") {
            let file_path = &line[3..];
            let full_path = std::path::Path::new(worktree_path).join(file_path);
            match std::fs::read_to_string(&full_path) {
                Ok(content) => {
                    let line_count = content.lines().count().max(1);
                    untracked_diffs.push_str(&format!("diff --git a/{f} b/{f}\nnew file mode 100644\n--- /dev/null\n+++ b/{f}\n@@ -0,0 +1,{line_count} @@\n", f = file_path));
                    for line in content.lines() {
                        untracked_diffs.push('+');
                        untracked_diffs.push_str(line);
                        untracked_diffs.push('\n');
                    }
                    if content.is_empty() {
                        untracked_diffs.push_str("+\n");
                    }
                }
                Err(_) => {
                    // Binary or unreadable file — generate a minimal diff header
                    untracked_diffs.push_str(&format!(
                        "diff --git a/{f} b/{f}\nnew file mode 100644\nBinary files /dev/null and b/{f} differ\n",
                        f = file_path
                    ));
                }
            }
        }
    }

    Ok(format!("{}{}{}", staged, unstaged, untracked_diffs))
}

#[derive(Debug, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_remote: bool,
}

pub fn create_worktree(
    repo_path: &str,
    branch_name: &str,
    base_branch: Option<String>,
    existing: bool,
    wt_path: &str,
) -> Result<Worktree, String> {
    if existing {
        run_git(repo_path, &["worktree", "add", wt_path, branch_name])?;
    } else {
        let base = base_branch.unwrap_or_else(|| "HEAD".to_string());
        let start_point = if base == "HEAD" {
            base
        } else {
            run_git(repo_path, &["fetch", "origin", &base])?;
            format!("origin/{}", base)
        };
        run_git(
            repo_path,
            &["worktree", "add", wt_path, "-b", branch_name, &start_point],
        )?;
    }

    // Read back the canonical path from git to avoid symlink mismatches
    // (e.g. /tmp -> /private/tmp on macOS)
    let canonical_path = std::fs::canonicalize(wt_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| wt_path.to_string());

    let head = run_git(&canonical_path, &["rev-parse", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();

    Ok(Worktree {
        path: canonical_path,
        branch: branch_name.to_string(),
        head_commit: head,
        title: None,
    })
}

pub fn delete_worktree(repo_path: &str, worktree_path: &str, force: bool, delete_branch: bool) -> Result<(), String> {
    let branch = if delete_branch {
        run_git(worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .ok()
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty() && b != "HEAD")
    } else {
        None
    };

    let mut args = vec!["worktree", "remove", worktree_path];
    if force {
        args.push("--force");
    }
    run_git(repo_path, &args)?;

    if let Some(branch) = branch {
        let _ = run_git(repo_path, &["branch", "-D", &branch]);
    }

    Ok(())
}


pub fn fetch_remote(repo_path: &str, remote: &str) -> Result<(), String> {
    // --prune drops local remote-tracking refs that no longer exist on the
    // remote, so the branch picker stays in sync with origin.
    run_git(repo_path, &["fetch", "--prune", remote])?;
    Ok(())
}

pub fn list_branches(repo_path: &str) -> Result<Vec<BranchInfo>, String> {
    let output = run_git(repo_path, &["branch", "-a", "--format=%(refname:short)"])?;
    let branches = output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let name = line.trim().to_string();
            let is_remote = name.starts_with("origin/");
            BranchInfo { name, is_remote }
        })
        .collect();
    Ok(branches)
}

pub fn check_generated_files(worktree_path: &str, files: &[String]) -> Result<Vec<String>, String> {
    if files.is_empty() {
        return Ok(vec![]);
    }

    let mut args = vec!["check-attr", "linguist-generated", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);

    let output = run_git(worktree_path, &args)?;
    let mut generated = Vec::new();

    for line in output.lines() {
        // Format: "path: linguist-generated: true"
        let parts: Vec<&str> = line.splitn(3, ": ").collect();
        if parts.len() == 3 && parts[2].trim() == "true" {
            generated.push(parts[0].to_string());
        }
    }

    Ok(generated)
}

pub fn get_head_commit(worktree_path: &str) -> Result<String, String> {
    run_git(worktree_path, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string())
}

/// Blob sha of the worktree copy of `file_path`, computed as git would store
/// it (`git hash-object <path>`). Used to key "viewed" state by content: two
/// worktree versions with identical bytes get the same sha.
pub fn hash_worktree_file(worktree_path: &str, file_path: &str) -> Result<String, String> {
    run_git(worktree_path, &["hash-object", "--", file_path]).map(|s| s.trim().to_string())
}

/// Blob sha of `file_path` as recorded in the tree of `git_ref` (a commit sha,
/// `HEAD`, a branch name, etc). Errors if the file doesn't exist at that ref.
pub fn blob_sha_at_ref(
    worktree_path: &str,
    git_ref: &str,
    file_path: &str,
) -> Result<String, String> {
    let spec = format!("{}:{}", git_ref, file_path);
    run_git(worktree_path, &["rev-parse", &spec]).map(|s| s.trim().to_string())
}

/// Map from file_path → blob sha for every file in `git_ref`'s tree.
/// One git invocation regardless of file count.
pub fn ls_tree_blobs(
    worktree_path: &str,
    git_ref: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    let output = run_git(worktree_path, &["ls-tree", "-r", "-z", git_ref])?;
    let mut map = std::collections::HashMap::new();
    // `-z` output: <mode> SP <type> SP <sha> TAB <path> NUL ...
    for entry in output.split('\0') {
        if entry.is_empty() {
            continue;
        }
        let (meta, path) = match entry.split_once('\t') {
            Some((m, p)) => (m, p),
            None => continue,
        };
        let mut parts = meta.splitn(3, ' ');
        let (_mode, _type, sha) = match (parts.next(), parts.next(), parts.next()) {
            (Some(m), Some(t), Some(s)) => (m, t, s),
            _ => continue,
        };
        map.insert(path.to_string(), sha.to_string());
    }
    Ok(map)
}

pub fn get_git_user_name() -> Option<String> {
    let output = Command::new("git")
        .args(["config", "--get", "user.name"])
        .env("PATH", augmented_path())
        .output()
        .ok()?;
    if output.status.success() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if name.is_empty() { None } else { Some(name) }
    } else {
        None
    }
}

pub fn get_all_changed_files(worktree_path: &str) -> Result<Vec<ChangedFile>, String> {
    let base = detect_base_branch(worktree_path)?;
    let range = format!("{}...HEAD", base);
    let output = run_git(worktree_path, &["diff", &range, "--name-status"])?;
    let files = output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.splitn(2, '\t');
            let status = parts.next().unwrap_or("?").to_string();
            let path = parts.next().unwrap_or("").to_string();
            ChangedFile { status, path }
        })
        .collect();
    Ok(files)
}
