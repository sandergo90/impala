//! Provider-neutral issue tracking.
//!
//! A **Project** chooses its **Issue tracker** (Linear, Jira, or none). Unlike
//! the **Remote provider**, which is auto-detected from the git remote, the
//! issue tracker is an explicit per-Project setting — Linear and Jira are
//! independent of where the code is hosted. This module owns the shared types,
//! the `IssueTracker` trait both providers implement, and the resolver that
//! turns a project's settings into the right backend with its credentials.
//!
//! Credential scope is asymmetric (see docs/adr/0007): the Linear key is
//! global; the Jira connection (site/email/token) is per-Project.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub branch_name: String,
    pub status: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IssueComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IssueDetail {
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub url: String,
    pub status: String,
    pub comments: Vec<IssueComment>,
}

/// What every issue tracker can do for the Issue → Worktree flow. Methods are
/// blocking (HTTP); callers run them inside `spawn_blocking`.
pub trait IssueTracker: Send {
    /// The viewer's assigned, in-flight issues — the dropdown default.
    fn my_issues(&self) -> Result<Vec<Issue>, String>;
    /// Free-text issue search.
    fn search(&self, query: &str) -> Result<Vec<Issue>, String>;
    /// Description + comments for one issue, used to write its context file.
    fn issue_detail(&self, issue_id: &str) -> Result<IssueDetail, String>;
    /// Best-effort move to "In Progress". A no-op if already started or if the
    /// tracker offers no in-progress transition.
    fn start(&self, issue_id: &str) -> Result<(), String>;
}

/// A project's resolved tracker plus the credentials to reach it. Owned values
/// so it can be moved into `spawn_blocking`. `None` means either no tracker is
/// selected or its credentials are incomplete.
pub enum TrackerConfig {
    None,
    Linear {
        api_key: String,
    },
    Jira {
        base_url: String,
        email: String,
        token: String,
    },
}

impl TrackerConfig {
    pub fn into_tracker(self) -> Option<Box<dyn IssueTracker>> {
        match self {
            TrackerConfig::None => None,
            TrackerConfig::Linear { api_key } => {
                Some(Box::new(crate::linear::LinearTracker::new(api_key)))
            }
            TrackerConfig::Jira {
                base_url,
                email,
                token,
            } => Some(Box::new(crate::jira::JiraTracker::new(base_url, email, token))),
        }
    }
}

/// Which tracker a Project resolves to, for the UI's New Worktree tab.
/// `configured` is false when the matching credentials are missing, so the
/// dialog can show the right tab plus a "configure credentials" hint rather
/// than hiding the tab entirely.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueTrackerInfo {
    pub tracker: String,
    pub configured: bool,
}

/// The read-time default rule (docs/adr/0007): the stored per-Project
/// selection wins; absent that, Linear when a global Linear key exists, else
/// none. Not gated on credential completeness.
fn selected_kind(conn: &Connection, project_path: &str) -> Result<String, String> {
    let selected = crate::settings::get_setting(conn, "issueTracker", project_path)?;
    Ok(match selected.as_deref() {
        Some("jira") => "jira".to_string(),
        Some("linear") => "linear".to_string(),
        Some("none") => "none".to_string(),
        _ => {
            if linear_key(conn)?.is_some() {
                "linear".to_string()
            } else {
                "none".to_string()
            }
        }
    })
}

fn linear_key(conn: &Connection) -> Result<Option<String>, String> {
    Ok(crate::settings::get_setting(conn, "linearApiKey", "global")?
        .filter(|k| !k.trim().is_empty()))
}

fn jira_field(conn: &Connection, project_path: &str, key: &str) -> Result<Option<String>, String> {
    Ok(crate::settings::get_setting(conn, key, project_path)?.filter(|v| !v.trim().is_empty()))
}

pub fn tracker_info(conn: &Connection, project_path: &str) -> Result<IssueTrackerInfo, String> {
    let tracker = selected_kind(conn, project_path)?;
    let configured = match tracker.as_str() {
        "linear" => linear_key(conn)?.is_some(),
        "jira" => {
            jira_field(conn, project_path, "jiraSiteUrl")?.is_some()
                && jira_field(conn, project_path, "jiraEmail")?.is_some()
                && jira_field(conn, project_path, "jiraApiToken")?.is_some()
        }
        _ => false,
    };
    Ok(IssueTrackerInfo {
        tracker,
        configured,
    })
}

/// Resolve a project to a usable tracker + credentials. Returns
/// `TrackerConfig::None` when no tracker is selected or its credentials are
/// incomplete, so callers degrade gracefully instead of erroring.
pub fn read_tracker_config(
    conn: &Connection,
    project_path: &str,
) -> Result<TrackerConfig, String> {
    match selected_kind(conn, project_path)?.as_str() {
        "linear" => match linear_key(conn)? {
            Some(api_key) => Ok(TrackerConfig::Linear { api_key }),
            None => Ok(TrackerConfig::None),
        },
        "jira" => {
            let (Some(base_url), Some(email), Some(token)) = (
                jira_field(conn, project_path, "jiraSiteUrl")?,
                jira_field(conn, project_path, "jiraEmail")?,
                jira_field(conn, project_path, "jiraApiToken")?,
            ) else {
                return Ok(TrackerConfig::None);
            };
            Ok(TrackerConfig::Jira {
                base_url: normalize_base_url(&base_url),
                email,
                token,
            })
        }
        _ => Ok(TrackerConfig::None),
    }
}

/// Accept `company.atlassian.net`, `https://company.atlassian.net`, or a
/// trailing-slash variant and produce a clean `https://...` origin.
fn normalize_base_url(raw: &str) -> String {
    let t = raw.trim().trim_end_matches('/');
    if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        format!("https://{}", t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_url_forms() {
        assert_eq!(
            normalize_base_url("company.atlassian.net"),
            "https://company.atlassian.net"
        );
        assert_eq!(
            normalize_base_url("https://company.atlassian.net/"),
            "https://company.atlassian.net"
        );
        assert_eq!(
            normalize_base_url("  https://company.atlassian.net  "),
            "https://company.atlassian.net"
        );
    }
}
