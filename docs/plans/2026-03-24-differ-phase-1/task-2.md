# Task 2: Git CLI Bridge Commands

**Plan:** Differ Phase 1 — Walking Skeleton
**Goal:** Implement Tauri commands that shell out to `git` CLI and return structured JSON for: listing worktrees, detecting base branch, getting diverged commits, listing changed files, and generating diffs.
**Depends on:** Task 1

**Files:**

- Create: `src-tauri/src/git.rs`
- Modify: `src-tauri/src/lib.rs`

**Context:**

All git commands use `Command::new("git").arg("-C").arg(&worktree_path)` to run in the correct worktree directory. Commands return `Result<T, String>` where the error is the git stderr output. All structs derive `serde::Serialize` for JSON serialization to the frontend.

**Steps:**

1. Create `src-tauri/src/git.rs` with the data types and helper:

```rust
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
```

2. Add `list_worktrees` to `src-tauri/src/git.rs`:

```rust
pub fn list_worktrees(repo_path: &str) -> Result<Vec<Worktree>, String> {
    let output = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = Vec::new();
    let mut path = String::new();
    let mut branch = String::new();
    let mut head = String::new();

    for line in output.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = p.to_string();
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            // branch is like "refs/heads/feature/auth", extract the short name
            branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        } else if line.is_empty() && !path.is_empty() {
            worktrees.push(Worktree {
                path: path.clone(),
                branch: if branch.is_empty() { "HEAD (detached)".to_string() } else { branch.clone() },
                head_commit: head.clone(),
            });
            path.clear();
            branch.clear();
            head.clear();
        }
    }
    // Handle last entry if no trailing newline
    if !path.is_empty() {
        worktrees.push(Worktree {
            path,
            branch: if branch.is_empty() { "HEAD (detached)".to_string() } else { branch },
            head_commit: head,
        });
    }

    Ok(worktrees)
}
```

3. Add `detect_base_branch` to `src-tauri/src/git.rs`:

```rust
pub fn detect_base_branch(worktree_path: &str) -> Result<String, String> {
    // Try develop, main, master in order
    for branch in &["develop", "main", "master"] {
        let result = run_git(worktree_path, &["rev-parse", "--verify", branch]);
        if result.is_ok() {
            return Ok(branch.to_string());
        }
    }

    // Try default remote branch
    let remote_head = run_git(worktree_path, &["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if let Ok(ref_str) = remote_head {
        let branch = ref_str.trim()
            .strip_prefix("refs/remotes/origin/")
            .unwrap_or(ref_str.trim())
            .to_string();
        return Ok(branch);
    }

    // Final fallback: first commit on current branch
    let first_commit = run_git(worktree_path, &["rev-list", "--max-parents=0", "HEAD"])?;
    Ok(first_commit.trim().to_string())
}
```

4. Add `get_diverged_commits` to `src-tauri/src/git.rs`:

```rust
pub fn get_diverged_commits(worktree_path: &str, base_branch: Option<String>) -> Result<Vec<CommitInfo>, String> {
    let base = match base_branch {
        Some(b) => b,
        None => detect_base_branch(worktree_path)?,
    };

    let range = format!("{}..HEAD", base);
    let output = run_git(worktree_path, &[
        "log", &range,
        "--format=%H%n%s%n%an%n%aI%n---",
    ])?;

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
        let _separator = lines.next(); // consume "---"

        commits.push(CommitInfo { hash, message, author, date });
    }

    Ok(commits)
}
```

5. Add `get_changed_files` and `get_commit_diff` to `src-tauri/src/git.rs`:

```rust
pub fn get_changed_files(worktree_path: &str, commit_hash: &str) -> Result<Vec<ChangedFile>, String> {
    let output = run_git(worktree_path, &[
        "diff-tree", "--no-commit-id", "-r", "--name-status", commit_hash,
    ])?;

    let files = output.lines()
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

pub fn get_commit_diff(worktree_path: &str, commit_hash: &str, file_path: &str) -> Result<String, String> {
    let range = format!("{}~1..{}", commit_hash, commit_hash);
    run_git(worktree_path, &["diff", &range, "--", file_path])
}
```

6. Wire all commands as Tauri commands in `src-tauri/src/lib.rs`. Add `mod git;` at the top, then add the command functions:

```rust
mod git;

#[tauri::command]
fn list_worktrees(repo_path: String) -> Result<Vec<git::Worktree>, String> {
    git::list_worktrees(&repo_path)
}

#[tauri::command]
fn detect_base_branch(worktree_path: String) -> Result<String, String> {
    git::detect_base_branch(&worktree_path)
}

#[tauri::command]
fn get_diverged_commits(worktree_path: String, base_branch: Option<String>) -> Result<Vec<git::CommitInfo>, String> {
    git::get_diverged_commits(&worktree_path, base_branch)
}

#[tauri::command]
fn get_changed_files(worktree_path: String, commit_hash: String) -> Result<Vec<git::ChangedFile>, String> {
    git::get_changed_files(&worktree_path, &commit_hash)
}

#[tauri::command]
fn get_commit_diff(worktree_path: String, commit_hash: String, file_path: String) -> Result<String, String> {
    git::get_commit_diff(&worktree_path, &commit_hash, &file_path)
}
```

Register them in the builder (keep any existing plugins like `tauri_plugin_shell`):

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            list_worktrees,
            detect_base_branch,
            get_diverged_commits,
            get_changed_files,
            get_commit_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

7. Verify the Rust code compiles:

```bash
cd /Users/sander/Projects/differ/differ/src-tauri && cargo build
```

Expected: Compiles without errors.

8. Create a quick smoke test. Open the app and test one command from the browser console. Run:

```bash
cd /Users/sander/Projects/differ/differ && bun run tauri dev
```

In the app's dev tools console (Cmd+Option+I), run:

```javascript
const { invoke } = window.__TAURI__.core;
await invoke('list_worktrees', { repoPath: '/Users/sander/Projects/differ/differ' });
```

Expected: Returns an array with at least one worktree object.

9. Commit:

```bash
cd /Users/sander/Projects/differ/differ
git add src-tauri/src/git.rs src-tauri/src/lib.rs
git commit -m "feat: add git CLI bridge commands (worktrees, commits, diff)"
```

**Done When:**

- [ ] `cargo build` succeeds in `src-tauri/`
- [ ] `list_worktrees` returns worktree data when invoked
- [ ] `detect_base_branch` returns a branch name
- [ ] `get_diverged_commits` returns commit list
- [ ] `get_changed_files` returns file status list
- [ ] `get_commit_diff` returns raw diff text
- [ ] Committed
