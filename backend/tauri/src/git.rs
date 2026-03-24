use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub head_commit: String,
}

#[derive(Debug, Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Serialize)]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
}

fn run_git(worktree_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
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

    Ok(worktrees)
}

pub fn detect_base_branch(worktree_path: &str) -> Result<String, String> {
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
        &["log", &range, "--format=%H%n%s%n%an%n%aI%n---"],
    )?;

    let mut commits = Vec::new();
    let mut lines = output.lines().peekable();

    while lines.peek().is_some() {
        let hash = match lines.next() {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => break,
        };
        let message = lines.next().unwrap_or("").to_string();
        let author = lines.next().unwrap_or("").to_string();
        let date = lines.next().unwrap_or("").to_string();
        let _separator = lines.next();

        commits.push(CommitInfo {
            hash,
            message,
            author,
            date,
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
) -> Result<Worktree, String> {
    let wt_path = format!("{}/.worktrees/{}", repo_path, branch_name);

    if existing {
        run_git(repo_path, &["worktree", "add", &wt_path, branch_name])?;
    } else {
        let base = base_branch.unwrap_or_else(|| "HEAD".to_string());
        run_git(
            repo_path,
            &["worktree", "add", &wt_path, "-b", branch_name, &base],
        )?;
    }

    // Read back the worktree info
    let head = run_git(&wt_path, &["rev-parse", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();

    Ok(Worktree {
        path: wt_path,
        branch: branch_name.to_string(),
        head_commit: head,
    })
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
