//! Jira Cloud-backed `IssueTracker`.
//!
//! Talks directly to the Jira Cloud REST API v3 with Basic auth
//! (`email:api_token`), mirroring how `linear.rs` owns a credential and calls
//! its provider's API. See docs/adr/0007 for why Jira uses a stored token
//! rather than a CLI like `bkt`.
//!
//! One Jira-specific wrinkle vs Linear: **search** uses the Enhanced JQL
//! endpoint `/rest/api/3/search/jql`; the legacy `/rest/api/3/search` was
//! removed by Atlassian in late 2025.

use crate::issue_tracker::{Issue, IssueDetail, IssueTracker};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::sync::LazyLock;

static CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(reqwest::blocking::Client::new);

/// Jira-backed `IssueTracker`. `base_url` is a clean `https://...` origin;
/// `email`/`token` form the Basic auth credential.
pub struct JiraTracker {
    base_url: String,
    auth: String,
}

impl JiraTracker {
    pub fn new(base_url: String, email: String, token: String) -> Self {
        let auth = format!("Basic {}", STANDARD.encode(format!("{}:{}", email, token)));
        Self { base_url, auth }
    }

    fn browse_url(&self, key: &str) -> String {
        format!("{}/browse/{}", self.base_url, key)
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        let resp = CLIENT
            .get(format!("{}{}", self.base_url, path))
            .header("Accept", "application/json")
            .header("Authorization", &self.auth)
            .send()
            .map_err(|e| format!("Jira request failed: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .map_err(|e| format!("Failed to read Jira response: {}", e))?;
        if !status.is_success() {
            return Err(format!(
                "Jira API returned status {}: {}",
                status,
                first_error(&text)
            ));
        }
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse Jira response: {}", e))
    }

    fn post(&self, path: &str, body: &Value) -> Result<(), String> {
        let resp = CLIENT
            .post(format!("{}{}", self.base_url, path))
            .header("Authorization", &self.auth)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .map_err(|e| format!("Jira request failed: {}", e))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().unwrap_or_default();
            return Err(format!(
                "Jira API returned status {}: {}",
                status,
                first_error(&text)
            ));
        }
        Ok(())
    }

    fn search_jql(&self, jql: &str, fields: &str, max: u32) -> Result<Vec<Issue>, String> {
        // Enhanced JQL endpoint. Pagination is nextPageToken-based; we only
        // need the first page for the dropdown / search box.
        let path = format!(
            "/rest/api/3/search/jql?jql={}&fields={}&maxResults={}",
            urlencode(jql),
            urlencode(fields),
            max
        );
        let data = self.get(&path)?;
        let issues = data
            .get("issues")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(issues.iter().map(|n| self.node_to_issue(n)).collect())
    }

    fn node_to_issue(&self, node: &Value) -> Issue {
        let id = node
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let key = node
            .get("key")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let fields = node.get("fields");
        let title = fields
            .and_then(|f| f.get("summary"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = fields
            .and_then(|f| f.get("status"))
            .and_then(|s| s.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Issue {
            id,
            branch_name: derive_branch_name(&key, &title),
            url: self.browse_url(&key),
            identifier: key,
            title,
            status,
        }
    }
}

impl IssueTracker for JiraTracker {
    fn my_issues(&self) -> Result<Vec<Issue>, String> {
        self.search_jql(
            "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
            "summary,status",
            50,
        )
    }

    fn search(&self, query: &str) -> Result<Vec<Issue>, String> {
        let sanitized = query.replace('\\', "").replace('"', "");
        let trimmed = sanitized.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        // `text ~` only searches summary/description/comments, so a bare issue
        // key like "SBSTR-7" finds nothing. When the query is key-shaped, try an
        // exact key lookup first; fall back to text search if it's not a real key
        // (`key = ...` 400s on a nonexistent key, so swallow that and degrade).
        if looks_like_issue_key(trimmed) {
            let jql = format!("key = \"{}\" ORDER BY updated DESC", trimmed.to_uppercase());
            if let Ok(issues) = self.search_jql(&jql, "summary,status", 20) {
                if !issues.is_empty() {
                    return Ok(issues);
                }
            }
        }
        let jql = format!("text ~ \"{}*\" ORDER BY updated DESC", trimmed);
        self.search_jql(&jql, "summary,status", 20)
    }

    fn issue_detail(&self, _issue_id: &str) -> Result<IssueDetail, String> {
        // Jira tickets are not fetched into a context file; the agent reads
        // the ticket itself (e.g. via a Jira skill). Linear keeps using this.
        Err("Jira issue detail fetching is not supported".to_string())
    }

    fn start(&self, issue_id: &str) -> Result<(), String> {
        // Already in an in-progress status? Nothing to do.
        let issue = self.get(&format!("/rest/api/3/issue/{}?fields=status", issue_id))?;
        let current_category = issue
            .get("fields")
            .and_then(|f| f.get("status"))
            .and_then(|s| s.get("statusCategory"))
            .and_then(|c| c.get("key"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if current_category == "indeterminate" {
            return Ok(());
        }

        // Jira workflows are custom: pick a transition whose target status is
        // in the "indeterminate" (In Progress) category, preferring one named
        // "In Progress". If the current status offers none, silently skip.
        let data = self.get(&format!("/rest/api/3/issue/{}/transitions", issue_id))?;
        let transitions = data
            .get("transitions")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let in_progress: Vec<&Value> = transitions
            .iter()
            .filter(|t| {
                t.get("to")
                    .and_then(|to| to.get("statusCategory"))
                    .and_then(|c| c.get("key"))
                    .and_then(|v| v.as_str())
                    == Some("indeterminate")
            })
            .collect();

        let chosen = in_progress
            .iter()
            .find(|t| {
                t.get("to")
                    .and_then(|to| to.get("name"))
                    .and_then(|v| v.as_str())
                    == Some("In Progress")
            })
            .or_else(|| in_progress.first());

        let Some(transition) = chosen else {
            return Ok(());
        };
        let Some(id) = transition.get("id").and_then(|v| v.as_str()) else {
            return Ok(());
        };

        self.post(
            &format!("/rest/api/3/issue/{}/transitions", issue_id),
            &serde_json::json!({ "transition": { "id": id } }),
        )
    }
}

fn first_error(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return body.chars().take(200).collect();
    };
    if let Some(msg) = v
        .get("errorMessages")
        .and_then(|m| m.as_array())
        .and_then(|a| a.first())
        .and_then(|m| m.as_str())
    {
        return msg.to_string();
    }
    if let Some(errors) = v.get("errors").and_then(|e| e.as_object()) {
        if let Some((_, msg)) = errors.iter().next() {
            if let Some(s) = msg.as_str() {
                return s.to_string();
            }
        }
    }
    body.chars().take(200).collect()
}

/// True for a bare Jira issue key like `SBSTR-7`: a project key (a letter then
/// letters/digits), a hyphen, then digits. These are matched by `key =`, not the
/// `text ~` operator used for free-text search.
fn looks_like_issue_key(s: &str) -> bool {
    let Some((project, number)) = s.split_once('-') else {
        return false;
    };
    !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
        && project
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        && project.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Percent-encode a query-string value (Jira JQL contains spaces, quotes, `=`).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Jira gives no server-side branch name, so derive `KEY-slugified-title`. The
/// key stays uppercase so Bitbucket↔Jira branch linking recognizes it.
pub fn derive_branch_name(key: &str, title: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    let slug: String = slug.chars().take(50).collect();
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        key.to_string()
    } else {
        format!("{}-{}", key, slug)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_branch_name_uppercase_key_lower_slug() {
        assert_eq!(
            derive_branch_name("RAC-45", "Fix login redirect!"),
            "RAC-45-fix-login-redirect"
        );
        assert_eq!(
            derive_branch_name("RAC-1", "  Spaces   and---dashes  "),
            "RAC-1-spaces-and-dashes"
        );
        // No usable title → key only.
        assert_eq!(derive_branch_name("RAC-9", "***"), "RAC-9");
    }

    #[test]
    fn recognizes_bare_issue_keys() {
        assert!(looks_like_issue_key("SBSTR-7"));
        assert!(looks_like_issue_key("sbstr-7")); // uppercased before the JQL
        assert!(looks_like_issue_key("RAC2-45")); // digits allowed in project key
                                                  // Free text, partial keys, and malformed keys fall through to text search.
        assert!(!looks_like_issue_key("opname start"));
        assert!(!looks_like_issue_key("SBSTR-"));
        assert!(!looks_like_issue_key("SBSTR"));
        assert!(!looks_like_issue_key("7-SBSTR"));
        assert!(!looks_like_issue_key("SBSTR-7a"));
    }
}
