//! Bitbucket Cloud Pull request status, sourced from the `bkt` CLI.
//!
//! Mirrors `github.rs`: shell out to a CLI that owns its own (keychain)
//! credentials, parse JSON, and fill the provider-neutral `PrInfo`. Scope is
//! Tier B — existence/state/draft/branch/title/link plus the CI checks rollup.
//! Review decision and line counts are intentionally not fetched. See
//! docs/adr/0006.

use crate::github::{ChecksRollup, ChecksStatus, PrInfo, PrState, PrStatus};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

// ---- Remote detection -----------------------------------------------------

pub(crate) fn is_bitbucket_remote(remote_url: &str) -> bool {
    let t = remote_url.trim();
    t.starts_with("https://bitbucket.org/")
        || t.starts_with("http://bitbucket.org/")
        || t.starts_with("git@bitbucket.org:")
        || t.starts_with("ssh://git@bitbucket.org/")
}

/// Extract `(workspace, repo_slug)` from a Bitbucket Cloud `origin` URL.
/// `bkt` resolves the repo from its active context or explicit flags — never
/// from the cwd's git remote — so Impala parses it and passes it through.
fn parse_workspace_repo(remote_url: &str) -> Option<(String, String)> {
    let t = remote_url.trim();
    let path = t
        .strip_prefix("git@bitbucket.org:")
        .or_else(|| t.strip_prefix("ssh://git@bitbucket.org/"))
        .or_else(|| t.strip_prefix("https://bitbucket.org/"))
        .or_else(|| t.strip_prefix("http://bitbucket.org/"))?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let workspace = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if workspace.is_empty() || repo.is_empty() {
        return None;
    }
    Some((workspace, repo))
}

// ---- Fetch pipeline -------------------------------------------------------

// Bitbucket Cloud has tighter rate limits than the 60s all-worktrees poll
// assumes at ~2 calls per refresh. Collapse focus/timer/fs-change bursts to at
// most one fetch per MIN_REFRESH per worktree. See docs/adr/0006.
const MIN_REFRESH: Duration = Duration::from_secs(60);
static LAST_FETCH: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn throttled(worktree_path: &str) -> bool {
    let guard = LAST_FETCH.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .and_then(|m| m.get(worktree_path))
        .map(|at| at.elapsed() < MIN_REFRESH)
        .unwrap_or(false)
}

fn mark_fetched(worktree_path: &str) {
    let mut guard = LAST_FETCH.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(worktree_path.to_string(), Instant::now());
}

pub(crate) fn fetch_pr_status(worktree_path: &str) -> Result<PrStatus, String> {
    // An Err here (throttled or otherwise) leaves the cached row untouched and
    // emits nothing — the same silent-failure path as any other fetch error.
    if throttled(worktree_path) {
        return Err("throttled".to_string());
    }
    mark_fetched(worktree_path);

    let remote_url = match crate::git::run_git(worktree_path, &["remote", "get-url", "origin"]) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return Ok(PrStatus::Unsupported),
    };
    let Some((workspace, repo)) = parse_workspace_repo(&remote_url) else {
        return Ok(PrStatus::Unsupported);
    };

    let cli = cli_status();
    if !cli.installed || !cli.authenticated {
        return Err("bkt unavailable".to_string());
    }

    let local_branch = crate::git::run_git(worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if local_branch.is_empty() || local_branch == "HEAD" {
        return Ok(PrStatus::NoPr);
    }
    // Base branches (main/master/develop) aren't feature branches with their
    // own PRs — mirror the GitHub path.
    if crate::worktrees::is_main_branch(&local_branch) {
        return Ok(PrStatus::NoPr);
    }

    // `bkt pr list` has no server-side --head filter and a single-valued
    // --state, so list per state and match the source branch client-side.
    // Query OPEN first (the common case), then fall back to MERGED. DECLINED is
    // intentionally omitted to bound the call count.
    let pr = match find_pr(worktree_path, &workspace, &repo, "OPEN", &local_branch)? {
        Some(p) => Some(p),
        None => find_pr(worktree_path, &workspace, &repo, "MERGED", &local_branch)?,
    };

    let Some(pr) = pr else {
        return Ok(PrStatus::NoPr);
    };

    let checks = fetch_checks(worktree_path, &workspace, &repo, pr.id);
    Ok(PrStatus::HasPr(pr.into_pr_info(checks)))
}

fn find_pr(
    cwd: &str,
    workspace: &str,
    repo: &str,
    state: &str,
    branch: &str,
) -> Result<Option<BktPr>, String> {
    let json = run_bkt(
        cwd,
        &[
            "pr",
            "list",
            "--workspace",
            workspace,
            "--repo",
            repo,
            "--state",
            state,
            "--limit",
            "50",
            "--json",
        ],
    )?;
    let resp: BktListResponse =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse bkt pr list: {}", e))?;
    Ok(resp
        .pull_requests
        .unwrap_or_default()
        .into_iter()
        .find(|p| p.source.branch.name == branch))
}

fn fetch_checks(cwd: &str, workspace: &str, repo: &str, id: i64) -> ChecksRollup {
    let empty = ChecksRollup {
        status: None,
        passing: 0,
        total: 0,
    };
    let id_str = id.to_string();
    let Ok(json) = run_bkt(
        cwd,
        &[
            "pr",
            "checks",
            &id_str,
            "--workspace",
            workspace,
            "--repo",
            repo,
            "--json",
        ],
    ) else {
        return empty;
    };
    match serde_json::from_str::<BktChecksResponse>(&json) {
        Ok(resp) => checks_rollup(&resp.statuses.unwrap_or_default()),
        Err(_) => empty,
    }
}

fn run_bkt(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("bkt")
        .current_dir(cwd)
        .env("PATH", crate::git::augmented_path())
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute bkt: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

// ---- CLI status -----------------------------------------------------------

const CLI_STATUS_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketCliStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub username: Option<String>,
    /// "oauth" (short-lived) or "api_token" (long-lived) — lets the settings
    /// pane steer users toward the durable token. See docs/adr/0006.
    pub auth_method: Option<String>,
    pub expires: Option<String>,
}

fn unauthenticated(installed: bool) -> BitbucketCliStatus {
    BitbucketCliStatus {
        installed,
        authenticated: false,
        username: None,
        auth_method: None,
        expires: None,
    }
}

static CLI_STATUS_CACHE: Mutex<Option<(BitbucketCliStatus, Instant)>> = Mutex::new(None);

pub(crate) fn cli_status() -> BitbucketCliStatus {
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

pub(crate) fn invalidate_cli_status_cache() {
    *CLI_STATUS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn fetch_cli_status() -> BitbucketCliStatus {
    let installed = Command::new("bkt")
        .arg("--version")
        .env("PATH", crate::git::augmented_path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !installed {
        return unauthenticated(false);
    }

    let Ok(out) = Command::new("bkt")
        .args(["auth", "status", "--json"])
        .env("PATH", crate::git::augmented_path())
        .output()
    else {
        return unauthenticated(true);
    };
    if !out.status.success() {
        return unauthenticated(true);
    }
    let Ok(auth) = serde_json::from_slice::<BktAuthStatus>(&out.stdout) else {
        return unauthenticated(true);
    };

    // A Cloud host with a non-empty username is one we can query PRs against.
    match auth.hosts.into_iter().find(|h| {
        h.kind == "cloud"
            && h.username
                .as_deref()
                .map(|u| !u.is_empty())
                .unwrap_or(false)
    }) {
        Some(h) => BitbucketCliStatus {
            installed: true,
            authenticated: true,
            username: h.username,
            auth_method: h.auth_method,
            expires: h.expires,
        },
        None => unauthenticated(true),
    }
}

// ---- bkt JSON deserialization ---------------------------------------------

#[derive(Deserialize)]
struct BktListResponse {
    #[serde(default)]
    pull_requests: Option<Vec<BktPr>>,
}

#[derive(Deserialize)]
struct BktPr {
    id: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    source: BktEndpoint,
    #[serde(default)]
    links: BktLinks,
}

#[derive(Deserialize, Default)]
struct BktEndpoint {
    #[serde(default)]
    branch: BktNamed,
    #[serde(default)]
    commit: BktCommit,
}

#[derive(Deserialize, Default)]
struct BktNamed {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
struct BktCommit {
    #[serde(default)]
    hash: String,
}

#[derive(Deserialize, Default)]
struct BktLinks {
    #[serde(default)]
    html: BktHref,
}

#[derive(Deserialize, Default)]
struct BktHref {
    #[serde(default)]
    href: String,
}

#[derive(Deserialize)]
struct BktChecksResponse {
    #[serde(default)]
    statuses: Option<Vec<BktStatus>>,
}

#[derive(Deserialize)]
struct BktStatus {
    #[serde(default)]
    state: String,
}

#[derive(Deserialize)]
struct BktAuthStatus {
    #[serde(default)]
    hosts: Vec<BktHost>,
}

#[derive(Deserialize)]
struct BktHost {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    auth_method: Option<String>,
    #[serde(default)]
    expires: Option<String>,
}

impl BktPr {
    fn into_pr_info(self, checks: ChecksRollup) -> PrInfo {
        PrInfo {
            number: self.id,
            title: self.title,
            url: self.links.html.href,
            state: match self.state.as_str() {
                "MERGED" => PrState::Merged,
                "DECLINED" | "SUPERSEDED" => PrState::Closed,
                _ => PrState::Open,
            },
            is_draft: self.draft,
            // Tier B: not fetched for Bitbucket — these render conditionally,
            // so they simply don't appear on the hover card.
            review_decision: None,
            checks,
            additions: 0,
            deletions: 0,
            head_branch: self.source.branch.name,
            head_sha: self.source.commit.hash,
        }
    }
}

fn checks_rollup(statuses: &[BktStatus]) -> ChecksRollup {
    if statuses.is_empty() {
        return ChecksRollup {
            status: None,
            passing: 0,
            total: 0,
        };
    }
    let mut passing = 0;
    let mut any_failure = false;
    let mut any_pending = false;
    for s in statuses {
        match s.state.as_str() {
            "SUCCESSFUL" => passing += 1,
            "INPROGRESS" | "" => any_pending = true,
            _ => any_failure = true, // FAILED, STOPPED, …
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
        total: statuses.len() as i32,
    }
}

// ---- Tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_bitbucket_remote_accepts_common_forms() {
        assert!(is_bitbucket_remote("https://bitbucket.org/ws/repo.git"));
        assert!(is_bitbucket_remote("git@bitbucket.org:ws/repo.git"));
        assert!(is_bitbucket_remote("ssh://git@bitbucket.org/ws/repo.git"));
        assert!(is_bitbucket_remote("https://bitbucket.org/ws/repo"));
    }

    #[test]
    fn is_bitbucket_remote_rejects_others() {
        assert!(!is_bitbucket_remote("git@github.com:ws/repo.git"));
        assert!(!is_bitbucket_remote("https://gitlab.com/ws/repo.git"));
        assert!(!is_bitbucket_remote(""));
    }

    #[test]
    fn parses_ssh_and_https_workspace_repo() {
        assert_eq!(
            parse_workspace_repo("git@bitbucket.org:raccoons-group/rac-brugge-stt.git"),
            Some(("raccoons-group".into(), "rac-brugge-stt".into()))
        );
        assert_eq!(
            parse_workspace_repo("https://bitbucket.org/raccoons-group/rac-brugge-stt.git"),
            Some(("raccoons-group".into(), "rac-brugge-stt".into()))
        );
        assert_eq!(
            parse_workspace_repo("https://bitbucket.org/ws/repo"),
            Some(("ws".into(), "repo".into()))
        );
        assert_eq!(parse_workspace_repo("git@github.com:ws/repo.git"), None);
    }

    fn st(state: &str) -> BktStatus {
        BktStatus {
            state: state.into(),
        }
    }

    #[test]
    fn rollup_empty_is_none() {
        let r = checks_rollup(&[]);
        assert_eq!(r.status, None);
        assert_eq!(r.total, 0);
    }

    #[test]
    fn rollup_all_successful() {
        let r = checks_rollup(&[st("SUCCESSFUL"), st("SUCCESSFUL")]);
        assert_eq!(r.status, Some(ChecksStatus::Success));
        assert_eq!(r.passing, 2);
        assert_eq!(r.total, 2);
    }

    #[test]
    fn rollup_any_failed_is_failure() {
        let r = checks_rollup(&[st("SUCCESSFUL"), st("FAILED"), st("INPROGRESS")]);
        assert_eq!(r.status, Some(ChecksStatus::Failure));
    }

    #[test]
    fn rollup_inprogress_is_pending() {
        let r = checks_rollup(&[st("SUCCESSFUL"), st("INPROGRESS")]);
        assert_eq!(r.status, Some(ChecksStatus::Pending));
    }

    #[test]
    fn maps_declined_to_closed_and_merged_to_merged() {
        let mk = |state: &str| BktPr {
            id: 1,
            title: "t".into(),
            state: state.into(),
            draft: false,
            source: BktEndpoint::default(),
            links: BktLinks::default(),
        };
        let empty = ChecksRollup {
            status: None,
            passing: 0,
            total: 0,
        };
        assert_eq!(
            mk("MERGED").into_pr_info(empty.clone()).state,
            PrState::Merged
        );
        assert_eq!(
            mk("DECLINED").into_pr_info(empty.clone()).state,
            PrState::Closed
        );
        assert_eq!(mk("OPEN").into_pr_info(empty).state, PrState::Open);
    }
}
