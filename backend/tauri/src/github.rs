use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

// ---- Public types ---------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrStatus {
    Unsupported,
    NoPr,
    HasPr(PrInfo),
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: PrState,
    pub is_draft: bool,
    pub review_decision: Option<ReviewDecision>,
    pub checks: ChecksRollup,
    pub additions: i32,
    pub deletions: i32,
    pub head_branch: String,
    pub head_sha: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrState { Open, Closed, Merged }

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision { Approved, ChangesRequested, ReviewRequired }

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChecksRollup {
    pub status: Option<ChecksStatus>,
    pub passing: i32,
    pub total: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChecksStatus { Success, Failure, Pending }

// ---- Schema ---------------------------------------------------------------

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS github_pr_status (
            worktree_path   TEXT PRIMARY KEY,
            kind            TEXT NOT NULL,
            pr_number       INTEGER,
            title           TEXT,
            url             TEXT,
            state           TEXT,
            is_draft        INTEGER,
            review_decision TEXT,
            checks_status   TEXT,
            checks_passing  INTEGER,
            checks_total    INTEGER,
            additions       INTEGER,
            deletions       INTEGER,
            head_branch     TEXT,
            head_sha        TEXT,
            fetched_at      INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("Failed to initialize github_pr_status table: {}", e))
}

// ---- Storage --------------------------------------------------------------

pub fn read_status(conn: &Connection, worktree_path: &str) -> Result<Option<PrStatus>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT kind, pr_number, title, url, state, is_draft, review_decision,
                    checks_status, checks_passing, checks_total, additions, deletions,
                    head_branch, head_sha
             FROM github_pr_status WHERE worktree_path = ?1",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    stmt.query_row(params![worktree_path], row_to_status)
        .optional()
        .map_err(|e| format!("Failed to read pr status: {}", e))
}

pub fn upsert_status(
    conn: &Connection,
    worktree_path: &str,
    status: &PrStatus,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();

    match status {
        PrStatus::Unsupported | PrStatus::NoPr => {
            let kind = match status {
                PrStatus::Unsupported => "unsupported",
                PrStatus::NoPr => "no_pr",
                _ => unreachable!(),
            };
            conn.execute(
                "INSERT INTO github_pr_status (worktree_path, kind, fetched_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(worktree_path) DO UPDATE SET
                    kind=excluded.kind,
                    pr_number=NULL, title=NULL, url=NULL, state=NULL,
                    is_draft=NULL, review_decision=NULL, checks_status=NULL,
                    checks_passing=NULL, checks_total=NULL, additions=NULL,
                    deletions=NULL, head_branch=NULL, head_sha=NULL,
                    fetched_at=excluded.fetched_at",
                params![worktree_path, kind, now],
            )
            .map_err(|e| format!("Failed to upsert status: {}", e))?;
        }
        PrStatus::HasPr(pr) => {
            conn.execute(
                "INSERT INTO github_pr_status
                    (worktree_path, kind, pr_number, title, url, state, is_draft,
                     review_decision, checks_status, checks_passing, checks_total,
                     additions, deletions, head_branch, head_sha, fetched_at)
                 VALUES (?1,'has_pr',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
                 ON CONFLICT(worktree_path) DO UPDATE SET
                    kind='has_pr',
                    pr_number=excluded.pr_number, title=excluded.title,
                    url=excluded.url, state=excluded.state, is_draft=excluded.is_draft,
                    review_decision=excluded.review_decision,
                    checks_status=excluded.checks_status,
                    checks_passing=excluded.checks_passing,
                    checks_total=excluded.checks_total,
                    additions=excluded.additions, deletions=excluded.deletions,
                    head_branch=excluded.head_branch, head_sha=excluded.head_sha,
                    fetched_at=excluded.fetched_at",
                params![
                    worktree_path,
                    pr.number, pr.title, pr.url,
                    pr_state_to_str(pr.state),
                    pr.is_draft as i32,
                    pr.review_decision.map(review_decision_to_str),
                    pr.checks.status.map(checks_status_to_str),
                    pr.checks.passing, pr.checks.total,
                    pr.additions, pr.deletions,
                    pr.head_branch, pr.head_sha,
                    now,
                ],
            )
            .map_err(|e| format!("Failed to upsert status: {}", e))?;
        }
    }
    Ok(())
}

pub(crate) fn delete_status(conn: &Connection, worktree_path: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM github_pr_status WHERE worktree_path = ?1",
        params![worktree_path],
    )
    .map_err(|e| format!("Failed to delete status: {}", e))?;
    Ok(())
}

// ---- Row mapping ----------------------------------------------------------

fn row_to_status(row: &rusqlite::Row) -> rusqlite::Result<PrStatus> {
    let kind: String = row.get(0)?;
    match kind.as_str() {
        "unsupported" => Ok(PrStatus::Unsupported),
        "no_pr" => Ok(PrStatus::NoPr),
        "has_pr" => Ok(PrStatus::HasPr(PrInfo {
            number: row.get(1)?,
            title: row.get(2)?,
            url: row.get(3)?,
            state: pr_state_from_str(&row.get::<_, String>(4)?),
            is_draft: row.get::<_, i32>(5)? != 0,
            review_decision: row
                .get::<_, Option<String>>(6)?
                .as_deref()
                .map(review_decision_from_str),
            checks: ChecksRollup {
                status: row
                    .get::<_, Option<String>>(7)?
                    .as_deref()
                    .map(checks_status_from_str),
                passing: row.get(8)?,
                total: row.get(9)?,
            },
            additions: row.get(10)?,
            deletions: row.get(11)?,
            head_branch: row.get(12)?,
            head_sha: row.get(13)?,
        })),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown kind: {}", other),
            )),
        )),
    }
}

fn pr_state_to_str(s: PrState) -> &'static str {
    match s {
        PrState::Open => "open",
        PrState::Closed => "closed",
        PrState::Merged => "merged",
    }
}
fn pr_state_from_str(s: &str) -> PrState {
    match s {
        "closed" => PrState::Closed,
        "merged" => PrState::Merged,
        _ => PrState::Open,
    }
}
fn review_decision_to_str(d: ReviewDecision) -> &'static str {
    match d {
        ReviewDecision::Approved => "approved",
        ReviewDecision::ChangesRequested => "changes_requested",
        ReviewDecision::ReviewRequired => "review_required",
    }
}
fn review_decision_from_str(s: &str) -> ReviewDecision {
    match s {
        "approved" => ReviewDecision::Approved,
        "changes_requested" => ReviewDecision::ChangesRequested,
        _ => ReviewDecision::ReviewRequired,
    }
}
fn checks_status_to_str(s: ChecksStatus) -> &'static str {
    match s {
        ChecksStatus::Success => "success",
        ChecksStatus::Failure => "failure",
        ChecksStatus::Pending => "pending",
    }
}
fn checks_status_from_str(s: &str) -> ChecksStatus {
    match s {
        "success" => ChecksStatus::Success,
        "failure" => ChecksStatus::Failure,
        _ => ChecksStatus::Pending,
    }
}

// ---- Fetch pipeline -------------------------------------------------------

use std::process::Command;

pub fn fetch_pr_status(worktree_path: &str) -> Result<PrStatus, String> {
    let remote_url = match crate::git::run_git(worktree_path, &["remote", "get-url", "origin"]) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return Ok(PrStatus::Unsupported),
    };
    if !is_github_remote(&remote_url) {
        return Ok(PrStatus::Unsupported);
    }

    let cli = cli_status();
    if !cli.installed || !cli.authenticated {
        return Err("gh unavailable".to_string());
    }

    let local_branch = crate::git::run_git(worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if local_branch.is_empty() || local_branch == "HEAD" {
        return Ok(PrStatus::NoPr);
    }

    // Base branches (main/master/develop) aren't feature branches with their
    // own PRs — whatever PR happens to have them as head is incidental.
    if crate::worktrees::is_main_branch(&local_branch) {
        return Ok(PrStatus::NoPr);
    }

    // Match by local branch name. Resolving via HEAD@{upstream} would mis-match
    // in the common case where a branch was created from (and thus tracks) a
    // base branch like origin/develop — we'd end up showing develop's PR.
    let json = run_gh(
        worktree_path,
        &[
            "pr", "list",
            "--head", &local_branch,
            "--state", "all",
            "--limit", "1",
            "--json",
            "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,additions,deletions,headRefName,headRefOid",
        ],
    )?;

    let prs: Vec<GhPr> = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse gh output: {}", e))?;

    Ok(match prs.into_iter().next() {
        None => PrStatus::NoPr,
        Some(pr) => PrStatus::HasPr(pr.into_pr_info()),
    })
}

fn run_gh(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("gh")
        .current_dir(cwd)
        .env("PATH", crate::git::augmented_path())
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute gh: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn is_github_remote(remote_url: &str) -> bool {
    let t = remote_url.trim();
    t.starts_with("https://github.com/")
        || t.starts_with("http://github.com/")
        || t.starts_with("git@github.com:")
        || t.starts_with("ssh://git@github.com/")
}

// ---- CLI status -----------------------------------------------------------

use std::sync::Mutex;
use std::time::{Duration, Instant};

const CLI_STATUS_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubCliStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub username: Option<String>,
}

static CLI_STATUS_CACHE: Mutex<Option<(GithubCliStatus, Instant)>> = Mutex::new(None);

/// Returns the cached CLI status if fresh, otherwise refetches.
pub(crate) fn cli_status() -> GithubCliStatus {
    {
        let guard = CLI_STATUS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((status, at)) = guard.as_ref() {
            if at.elapsed() < CLI_STATUS_TTL {
                return status.clone();
            }
        }
    }
    let fresh = fetch_cli_status();
    *CLI_STATUS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((fresh.clone(), Instant::now()));
    fresh
}

/// Drops the cached value; the next `cli_status()` call will refetch.
pub(crate) fn invalidate_cli_status_cache() {
    *CLI_STATUS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn fetch_cli_status() -> GithubCliStatus {
    let installed = Command::new("gh")
        .arg("--version")
        .env("PATH", crate::git::augmented_path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !installed {
        return GithubCliStatus { installed: false, authenticated: false, username: None };
    }

    let output = Command::new("gh")
        .args(["api", "user", "--jq", ".login"])
        .env("PATH", crate::git::augmented_path())
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let username = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if username.is_empty() {
                GithubCliStatus { installed: true, authenticated: false, username: None }
            } else {
                GithubCliStatus { installed: true, authenticated: true, username: Some(username) }
            }
        }
        _ => GithubCliStatus { installed: true, authenticated: false, username: None },
    }
}

// ---- gh JSON deserialization ---------------------------------------------

#[derive(Deserialize)]
struct GhPr {
    number: i64,
    title: String,
    url: String,
    state: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    #[serde(default, rename = "reviewDecision")]
    review_decision: String,
    #[serde(default, rename = "statusCheckRollup")]
    status_check_rollup: Vec<GhCheck>,
    #[serde(default)]
    additions: i32,
    #[serde(default)]
    deletions: i32,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "headRefOid")]
    head_ref_oid: String,
}

#[derive(Deserialize)]
struct GhCheck {
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: String,
}

impl GhPr {
    fn into_pr_info(self) -> PrInfo {
        PrInfo {
            number: self.number,
            title: self.title,
            url: self.url,
            state: match self.state.as_str() {
                "MERGED" => PrState::Merged,
                "CLOSED" => PrState::Closed,
                _ => PrState::Open,
            },
            is_draft: self.is_draft,
            review_decision: match self.review_decision.as_str() {
                "APPROVED" => Some(ReviewDecision::Approved),
                "CHANGES_REQUESTED" => Some(ReviewDecision::ChangesRequested),
                "REVIEW_REQUIRED" => Some(ReviewDecision::ReviewRequired),
                _ => None,
            },
            checks: checks_rollup(&self.status_check_rollup),
            additions: self.additions,
            deletions: self.deletions,
            head_branch: self.head_ref_name,
            head_sha: self.head_ref_oid,
        }
    }
}

fn checks_rollup(checks: &[GhCheck]) -> ChecksRollup {
    if checks.is_empty() {
        return ChecksRollup { status: None, passing: 0, total: 0 };
    }
    let mut passing = 0;
    let mut any_failure = false;
    let mut any_pending = false;
    for c in checks {
        if c.status != "COMPLETED" {
            any_pending = true;
            continue;
        }
        match c.conclusion.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => passing += 1,
            "" => any_pending = true,
            _ => any_failure = true,
        }
    }
    let status = if any_failure {
        ChecksStatus::Failure
    } else if any_pending {
        ChecksStatus::Pending
    } else {
        ChecksStatus::Success
    };
    ChecksRollup {
        status: Some(status),
        passing,
        total: checks.len() as i32,
    }
}

// ---- Tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_db(&c).unwrap();
        c
    }

    fn sample_pr() -> PrInfo {
        PrInfo {
            number: 42,
            title: "Fix bug".into(),
            url: "https://github.com/x/y/pull/42".into(),
            state: PrState::Open,
            is_draft: false,
            review_decision: Some(ReviewDecision::Approved),
            checks: ChecksRollup {
                status: Some(ChecksStatus::Success),
                passing: 5,
                total: 5,
            },
            additions: 10,
            deletions: 2,
            head_branch: "feat/x".into(),
            head_sha: "abc123".into(),
        }
    }

    #[test]
    fn read_missing_returns_none() {
        let c = mem_conn();
        assert_eq!(read_status(&c, "/nope").unwrap(), None);
    }

    #[test]
    fn roundtrip_unsupported() {
        let c = mem_conn();
        upsert_status(&c, "/wt/a", &PrStatus::Unsupported).unwrap();
        assert_eq!(read_status(&c, "/wt/a").unwrap(), Some(PrStatus::Unsupported));
    }

    #[test]
    fn roundtrip_no_pr() {
        let c = mem_conn();
        upsert_status(&c, "/wt/a", &PrStatus::NoPr).unwrap();
        assert_eq!(read_status(&c, "/wt/a").unwrap(), Some(PrStatus::NoPr));
    }

    #[test]
    fn roundtrip_has_pr() {
        let c = mem_conn();
        let info = sample_pr();
        upsert_status(&c, "/wt/b", &PrStatus::HasPr(info.clone())).unwrap();
        assert_eq!(read_status(&c, "/wt/b").unwrap(), Some(PrStatus::HasPr(info)));
    }

    #[test]
    fn upsert_overwrites_previous_kind() {
        let c = mem_conn();
        upsert_status(&c, "/wt/a", &PrStatus::HasPr(sample_pr())).unwrap();
        upsert_status(&c, "/wt/a", &PrStatus::NoPr).unwrap();
        assert_eq!(read_status(&c, "/wt/a").unwrap(), Some(PrStatus::NoPr));
    }

    #[test]
    fn roundtrip_has_pr_with_nulls() {
        let c = mem_conn();
        let info = PrInfo {
            review_decision: None,
            checks: ChecksRollup { status: None, passing: 0, total: 0 },
            ..sample_pr()
        };
        upsert_status(&c, "/wt/c", &PrStatus::HasPr(info.clone())).unwrap();
        assert_eq!(read_status(&c, "/wt/c").unwrap(), Some(PrStatus::HasPr(info)));
    }

    #[test]
    fn is_github_remote_accepts_common_forms() {
        assert!(is_github_remote("https://github.com/owner/repo.git"));
        assert!(is_github_remote("git@github.com:owner/repo.git"));
        assert!(is_github_remote("ssh://git@github.com/owner/repo.git"));
        assert!(is_github_remote("https://github.com/owner/repo"));
    }

    #[test]
    fn is_github_remote_rejects_non_github() {
        assert!(!is_github_remote("https://gitlab.com/owner/repo.git"));
        assert!(!is_github_remote("git@bitbucket.org:owner/repo.git"));
        assert!(!is_github_remote(""));
        assert!(!is_github_remote("github.com/owner/repo"));
    }

    fn check(status: &str, conclusion: &str) -> GhCheck {
        GhCheck { status: status.into(), conclusion: conclusion.into() }
    }

    #[test]
    fn rollup_empty() {
        let r = checks_rollup(&[]);
        assert_eq!(r.status, None);
        assert_eq!(r.total, 0);
    }

    #[test]
    fn rollup_all_success() {
        let checks = vec![
            check("COMPLETED", "SUCCESS"),
            check("COMPLETED", "NEUTRAL"),
            check("COMPLETED", "SKIPPED"),
        ];
        let r = checks_rollup(&checks);
        assert_eq!(r.status, Some(ChecksStatus::Success));
        assert_eq!(r.passing, 3);
        assert_eq!(r.total, 3);
    }

    #[test]
    fn rollup_any_failure_is_failure() {
        let checks = vec![
            check("COMPLETED", "SUCCESS"),
            check("COMPLETED", "FAILURE"),
            check("IN_PROGRESS", ""),
        ];
        let r = checks_rollup(&checks);
        assert_eq!(r.status, Some(ChecksStatus::Failure));
    }

    #[test]
    fn rollup_pending_when_not_all_completed() {
        let checks = vec![
            check("COMPLETED", "SUCCESS"),
            check("IN_PROGRESS", ""),
        ];
        let r = checks_rollup(&checks);
        assert_eq!(r.status, Some(ChecksStatus::Pending));
    }
}
