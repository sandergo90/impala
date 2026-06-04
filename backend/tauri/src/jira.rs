//! Jira Cloud-backed `IssueTracker`.
//!
//! Talks directly to the Jira Cloud REST API v3 with Basic auth
//! (`email:api_token`), mirroring how `linear.rs` owns a credential and calls
//! its provider's API. See docs/adr/0007 for why Jira uses a stored token
//! rather than a CLI like `bkt`.
//!
//! Two Jira-specific wrinkles vs Linear:
//! - **Search** uses the Enhanced JQL endpoint `/rest/api/3/search/jql`; the
//!   legacy `/rest/api/3/search` was removed by Atlassian in late 2025.
//! - **Rich text** (descriptions, comments) comes back as ADF, not markdown,
//!   so [`adf`] walks the node tree into a markdown subset.

use crate::issue_tracker::{Issue, IssueComment, IssueDetail, IssueTracker};
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
            .header("Authorization", &self.auth)
            .header("Accept", "application/json")
            .send()
            .map_err(|e| format!("Jira request failed: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .map_err(|e| format!("Failed to read Jira response: {}", e))?;
        if !status.is_success() {
            return Err(format!("Jira API returned status {}: {}", status, first_error(&text)));
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
            return Err(format!("Jira API returned status {}: {}", status, first_error(&text)));
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
        let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let key = node.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
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
        if sanitized.trim().is_empty() {
            return Ok(Vec::new());
        }
        let jql = format!("text ~ \"{}*\" ORDER BY updated DESC", sanitized.trim());
        self.search_jql(&jql, "summary,status", 20)
    }

    fn issue_detail(&self, issue_id: &str) -> Result<IssueDetail, String> {
        let data = self.get(&format!(
            "/rest/api/3/issue/{}?fields=summary,description,comment,status",
            issue_id
        ))?;
        let key = data.get("key").and_then(|v| v.as_str()).unwrap_or(issue_id);
        let fields = data.get("fields");

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
        let description = fields
            .and_then(|f| f.get("description"))
            .filter(|d| !d.is_null())
            .map(adf::to_markdown)
            .filter(|s| !s.trim().is_empty());

        let comments = fields
            .and_then(|f| f.get("comment"))
            .and_then(|c| c.get("comments"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|c| IssueComment {
                        author: c
                            .get("author")
                            .and_then(|a| a.get("displayName"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("Unknown")
                            .to_string(),
                        body: c.get("body").map(adf::to_markdown).unwrap_or_default(),
                        created_at: c
                            .get("created")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(IssueDetail {
            identifier: key.to_string(),
            title,
            description,
            url: self.browse_url(key),
            status,
            comments,
        })
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

/// Pull the first message out of a Jira `{ "errorMessages": [...], "errors": {...} }`
/// body so failures surface something readable rather than raw JSON.
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

/// ADF (Atlassian Document Format) → markdown. A pragmatic subset: the node
/// types that show up in real issue descriptions. Unknown nodes degrade by
/// recursing into their children so text is never lost. Media/attachments are
/// intentionally not rendered (deferred — see docs/adr/0007).
mod adf {
    use serde_json::Value;

    pub fn to_markdown(doc: &Value) -> String {
        let mut out = String::new();
        render(doc, &mut out);
        // Collapse runs of 3+ newlines the block emitters can produce.
        let mut collapsed = String::with_capacity(out.len());
        let mut newlines = 0;
        for ch in out.chars() {
            if ch == '\n' {
                newlines += 1;
                if newlines <= 2 {
                    collapsed.push(ch);
                }
            } else {
                newlines = 0;
                collapsed.push(ch);
            }
        }
        collapsed.trim().to_string()
    }

    fn children<'a>(node: &'a Value) -> &'a [Value] {
        node.get("content")
            .and_then(|c| c.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[])
    }

    fn node_type(node: &Value) -> &str {
        node.get("type").and_then(|t| t.as_str()).unwrap_or("")
    }

    fn render_children(node: &Value, out: &mut String) {
        for child in children(node) {
            render(child, out);
        }
    }

    fn render(node: &Value, out: &mut String) {
        match node_type(node) {
            "doc" => render_children(node, out),
            "paragraph" => {
                let mut line = String::new();
                render_children(node, &mut line);
                out.push_str(line.trim_end());
                out.push_str("\n\n");
            }
            "heading" => {
                let level = node
                    .get("attrs")
                    .and_then(|a| a.get("level"))
                    .and_then(|l| l.as_u64())
                    .unwrap_or(1)
                    .clamp(1, 6);
                for _ in 0..level {
                    out.push('#');
                }
                out.push(' ');
                render_children(node, out);
                out.push_str("\n\n");
            }
            "bulletList" => {
                render_list(node, None, out);
                out.push('\n');
            }
            "orderedList" => {
                render_list(node, Some(1), out);
                out.push('\n');
            }
            "codeBlock" => {
                let lang = node
                    .get("attrs")
                    .and_then(|a| a.get("language"))
                    .and_then(|l| l.as_str())
                    .unwrap_or("");
                out.push_str("```");
                out.push_str(lang);
                out.push('\n');
                let mut body = String::new();
                render_children(node, &mut body);
                out.push_str(body.trim_end());
                out.push_str("\n```\n\n");
            }
            "blockquote" => {
                let mut inner = String::new();
                render_children(node, &mut inner);
                for line in inner.trim_end().lines() {
                    out.push_str("> ");
                    out.push_str(line);
                    out.push('\n');
                }
                out.push('\n');
            }
            "rule" => out.push_str("---\n\n"),
            "text" => render_text(node, out),
            "hardBreak" => out.push('\n'),
            "mention" => out.push_str(
                node.get("attrs")
                    .and_then(|a| a.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("@unknown"),
            ),
            "emoji" => out.push_str(
                node.get("attrs")
                    .and_then(|a| a.get("text").or_else(|| a.get("shortName")))
                    .and_then(|t| t.as_str())
                    .unwrap_or(""),
            ),
            "inlineCard" | "blockCard" => {
                if let Some(url) = node
                    .get("attrs")
                    .and_then(|a| a.get("url"))
                    .and_then(|u| u.as_str())
                {
                    out.push_str(url);
                }
            }
            // Tables degrade to their cell text on separate lines — enough for
            // an agent to read, without a full markdown-table layout.
            "table" | "tableRow" | "tableCell" | "tableHeader" => {
                render_children(node, out);
            }
            "mediaSingle" | "mediaGroup" | "media" => out.push_str("[attachment]"),
            // Unknown node: keep its text by recursing.
            _ => render_children(node, out),
        }
    }

    fn render_list(node: &Value, ordered_start: Option<usize>, out: &mut String) {
        let mut index = ordered_start.unwrap_or(0);
        for item in children(node) {
            if node_type(item) != "listItem" {
                continue;
            }
            let mut item_text = String::new();
            render_children(item, &mut item_text);
            let item_text = item_text.trim();
            if item_text.is_empty() {
                continue;
            }
            let prefix = match ordered_start {
                Some(_) => {
                    let p = format!("{}. ", index);
                    index += 1;
                    p
                }
                None => "- ".to_string(),
            };
            for (i, line) in item_text.lines().enumerate() {
                if i == 0 {
                    out.push_str(&prefix);
                } else {
                    out.push_str("  ");
                }
                out.push_str(line);
                out.push('\n');
            }
        }
    }

    fn render_text(node: &Value, out: &mut String) {
        let text = node.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let mut s = text.to_string();
        if let Some(marks) = node.get("marks").and_then(|m| m.as_array()) {
            for mark in marks {
                match mark.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "strong" => s = format!("**{}**", s),
                    "em" => s = format!("_{}_", s),
                    "code" => s = format!("`{}`", s),
                    "strike" => s = format!("~~{}~~", s),
                    "link" => {
                        let href = mark
                            .get("attrs")
                            .and_then(|a| a.get("href"))
                            .and_then(|h| h.as_str())
                            .unwrap_or("");
                        s = format!("[{}]({})", s, href);
                    }
                    _ => {}
                }
            }
        }
        out.push_str(&s);
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
    fn adf_renders_common_nodes() {
        let doc = serde_json::json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 2 },
                  "content": [{ "type": "text", "text": "Title" }] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "Hello " },
                    { "type": "text", "text": "world", "marks": [{ "type": "strong" }] }
                ]},
                { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "one" }] }]},
                    { "type": "listItem", "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "two" }] }]}
                ]}
            ]
        });
        let md = adf::to_markdown(&doc);
        assert!(md.contains("## Title"));
        assert!(md.contains("Hello **world**"));
        assert!(md.contains("- one"));
        assert!(md.contains("- two"));
    }

    #[test]
    fn adf_link_and_code_marks() {
        let doc = serde_json::json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [
                { "type": "text", "text": "site", "marks": [
                    { "type": "link", "attrs": { "href": "https://x.com" } }]},
                { "type": "text", "text": " and " },
                { "type": "text", "text": "code", "marks": [{ "type": "code" }] }
            ]}]
        });
        let md = adf::to_markdown(&doc);
        assert_eq!(md, "[site](https://x.com) and `code`");
    }
}
