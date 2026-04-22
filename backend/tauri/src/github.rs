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

#[allow(dead_code)]
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

#[allow(dead_code)]
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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
}
