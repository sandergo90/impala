use base64::{engine::general_purpose::STANDARD, Engine as _};
use impala_daemon_shared::wire::{Request, Response as DaemonResponse};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Response, Server};

pub struct AgentStatuses(pub Mutex<HashMap<String, String>>);

pub struct AgentPaneStatuses {
    panes: Mutex<HashMap<(String, String), String>>,
    persist: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct AgentDelegation {
    delegation_id: String,
    worktree_path: String,
    name: Option<String>,
    pane_id: Option<String>,
    started: bool,
    error: Option<String>,
    created_at: i64,
    #[serde(default)]
    start_tree: Option<String>,
    #[serde(default)]
    end_tree: Option<String>,
    #[serde(default)]
    source_thread_id: Option<String>,
    #[serde(default)]
    source_app_server: Option<String>,
    #[serde(default)]
    target_thread_id: Option<String>,
    #[serde(default)]
    target_app_server: Option<String>,
    #[serde(default)]
    target_turn_id: Option<String>,
    #[serde(default)]
    completion_notified: bool,
    #[serde(skip)]
    completion_notification_in_flight: bool,
}

#[derive(Clone)]
pub struct AgentCompletionNotification {
    delegation_id: String,
    thread_id: String,
    app_server: String,
    prompt: String,
    target_worktree_path: String,
    target_pane_id: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct AgentRunChangeSummary {
    pub worktree_path: String,
    pub pane_id: String,
    pub name: Option<String>,
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub finished: bool,
}

#[derive(Serialize)]
pub struct AgentRunChanges {
    pub summary: AgentRunChangeSummary,
    pub changed_files: Vec<crate::git::ChangedFile>,
    pub diff: String,
    pub content_ref: String,
}

struct AgentRunChangeRefs {
    worktree_path: String,
    pane_id: String,
    name: Option<String>,
    start_tree: String,
    end_tree: String,
    finished: bool,
}

pub struct AgentDelegations {
    entries: Mutex<HashMap<String, AgentDelegation>>,
    persist: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum AgentFollowUpTarget {
    ManagedCodex {
        thread_id: String,
        app_server: String,
    },
    Pty {
        worktree_path: String,
        pane_id: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
struct AgentSteerTarget {
    thread_id: String,
    app_server: String,
    turn_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDelegationStatus {
    pub delegation_id: String,
    pub name: Option<String>,
    pub worktree_path: String,
    pub pane_id: Option<String>,
    pub created_at: i64,
    pub status: String,
    pub pane_status: String,
    pub error: Option<String>,
    pub callback_registered: bool,
    pub transport: String,
    pub thread_id: Option<String>,
    pub app_server_progress: Option<crate::codex_app_server::ManagedThreadProgress>,
    pub progress_error: Option<String>,
    pub can_steer: bool,
    pub can_follow_up: bool,
}

fn runtime_state_path(file_name: &str) -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".impala").join(file_name))
}

pub(crate) fn read_runtime_state<T: DeserializeOwned>(file_name: &str) -> Option<T> {
    let path = runtime_state_path(file_name)?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(crate) fn write_runtime_state<T: Serialize>(file_name: &str, value: &T) {
    let Some(path) = runtime_state_path(file_name) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    let Ok(bytes) = serde_json::to_vec(value) else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, bytes).is_ok() {
        if std::fs::rename(&temporary, &path).is_err() {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::rename(&temporary, &path);
        }
    }
}

impl AgentPaneStatuses {
    pub fn load_persisted() -> Self {
        let events: Vec<AgentPaneStatusEvent> =
            read_runtime_state("agent-pane-statuses.json").unwrap_or_default();
        Self {
            panes: Mutex::new(
                events
                    .into_iter()
                    .filter(|event| event.status != "idle")
                    .map(|event| ((event.worktree_path, event.pane_id), event.status))
                    .collect(),
            ),
            persist: true,
        }
    }

    fn persist(&self, panes: &HashMap<(String, String), String>) {
        if !self.persist {
            return;
        }
        let events: Vec<_> = panes
            .iter()
            .map(|((worktree_path, pane_id), status)| AgentPaneStatusEvent {
                worktree_path: worktree_path.clone(),
                pane_id: pane_id.clone(),
                status: status.clone(),
            })
            .collect();
        write_runtime_state("agent-pane-statuses.json", &events);
    }

    fn aggregate(map: &HashMap<(String, String), String>, worktree_path: &str) -> String {
        let statuses = map
            .iter()
            .filter(|((path, _), _)| path == worktree_path)
            .map(|(_, status)| status.as_str());
        if statuses.clone().any(|status| status == "permission") {
            "permission".to_owned()
        } else if statuses.clone().any(|status| status == "working") {
            "working".to_owned()
        } else {
            "idle".to_owned()
        }
    }

    pub fn observe(&self, worktree_path: &str, pane_id: &str, status: &str) -> String {
        let Ok(mut panes) = self.panes.lock() else {
            return status.to_owned();
        };
        let key = (worktree_path.to_owned(), pane_id.to_owned());
        if status == "idle" {
            panes.remove(&key);
        } else {
            panes.insert(key, status.to_owned());
        }
        let aggregate = Self::aggregate(&panes, worktree_path);
        self.persist(&panes);
        aggregate
    }

    pub fn contains(&self, worktree_path: &str, pane_id: &str) -> bool {
        let Ok(panes) = self.panes.lock() else {
            return false;
        };
        panes.contains_key(&(worktree_path.to_owned(), pane_id.to_owned()))
    }

    fn status(&self, worktree_path: &str, pane_id: &str) -> Option<String> {
        let Ok(panes) = self.panes.lock() else {
            return None;
        };
        panes
            .get(&(worktree_path.to_owned(), pane_id.to_owned()))
            .cloned()
    }

    pub fn interrupt(&self, worktree_path: &str, pane_id: &str) -> Option<String> {
        self.clear(worktree_path, pane_id)
    }

    pub fn clear(&self, worktree_path: &str, pane_id: &str) -> Option<String> {
        let Ok(mut panes) = self.panes.lock() else {
            return None;
        };
        let key = (worktree_path.to_owned(), pane_id.to_owned());
        panes.remove(&key)?;
        let aggregate = Self::aggregate(&panes, worktree_path);
        self.persist(&panes);
        Some(aggregate)
    }

    pub fn clear_worktree(&self, worktree_path: &str) -> bool {
        let Ok(mut panes) = self.panes.lock() else {
            return false;
        };
        let previous_len = panes.len();
        panes.retain(|(path, _), _| path != worktree_path);
        if panes.len() == previous_len {
            return false;
        }
        self.persist(&panes);
        true
    }

    pub fn snapshot(&self) -> Vec<AgentPaneStatusEvent> {
        let Ok(panes) = self.panes.lock() else {
            return Vec::new();
        };
        panes
            .iter()
            .map(|((worktree_path, pane_id), status)| AgentPaneStatusEvent {
                worktree_path: worktree_path.clone(),
                pane_id: pane_id.clone(),
                status: status.clone(),
            })
            .collect()
    }

    pub fn aggregate_snapshot(&self) -> HashMap<String, String> {
        let Ok(panes) = self.panes.lock() else {
            return HashMap::new();
        };
        let worktrees: HashSet<_> = panes.keys().map(|(path, _)| path.clone()).collect();
        worktrees
            .into_iter()
            .map(|path| {
                let status = Self::aggregate(&panes, &path);
                (path, status)
            })
            .collect()
    }
}

impl AgentDelegations {
    pub fn load_persisted() -> Self {
        let entries: Vec<AgentDelegation> =
            read_runtime_state("agent-delegations.json").unwrap_or_default();
        Self {
            entries: Mutex::new(
                entries
                    .into_iter()
                    .map(|entry| (entry.delegation_id.clone(), entry))
                    .collect(),
            ),
            persist: true,
        }
    }

    fn persist(&self, entries: &HashMap<String, AgentDelegation>) {
        if self.persist {
            write_runtime_state(
                "agent-delegations.json",
                &entries.values().cloned().collect::<Vec<_>>(),
            );
        }
    }

    pub fn open(
        &self,
        delegation_id: &str,
        worktree_path: &str,
        name: Option<&str>,
        source_thread_id: Option<&str>,
        source_app_server: Option<&str>,
    ) -> bool {
        let start_tree = match crate::git::snapshot_worktree(worktree_path) {
            Ok(tree) => Some(tree),
            Err(error) => {
                eprintln!(
                    "[impala] delegated agent change snapshot failed for {}: {}",
                    worktree_path, error
                );
                None
            }
        };
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        // Ponytail: keep the persisted registry bounded at 256 delegations;
        // move history to SQLite if orchestration needs long-term reporting.
        if entries.len() >= 256 && !entries.contains_key(delegation_id) {
            if let Some(oldest) = entries
                .values()
                .min_by_key(|entry| entry.created_at)
                .map(|entry| entry.delegation_id.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            delegation_id.to_owned(),
            AgentDelegation {
                delegation_id: delegation_id.to_owned(),
                worktree_path: worktree_path.to_owned(),
                name: name.map(str::to_owned),
                pane_id: None,
                started: false,
                error: None,
                created_at: chrono::Utc::now().timestamp(),
                start_tree,
                end_tree: None,
                source_thread_id: source_thread_id.map(str::to_owned),
                source_app_server: source_app_server.map(str::to_owned),
                target_thread_id: None,
                target_app_server: None,
                target_turn_id: None,
                completion_notified: false,
                completion_notification_in_flight: false,
            },
        );
        self.persist(&entries);
        true
    }

    fn open_from_managed_source(
        &self,
        delegation_id: &str,
        worktree_path: &str,
        name: Option<&str>,
        source_thread_id: &str,
        source_app_server: &str,
    ) -> bool {
        self.open(
            delegation_id,
            worktree_path,
            name,
            Some(source_thread_id),
            Some(source_app_server),
        )
    }

    pub fn register(&self, delegation_id: &str, pane_id: &str) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let Some(entry) = entries.get_mut(delegation_id) else {
            return false;
        };
        entry.pane_id = Some(pane_id.to_owned());
        self.persist(&entries);
        true
    }

    pub fn fail(&self, delegation_id: &str, error: &str) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let Some(entry) = entries.get_mut(delegation_id) else {
            return false;
        };
        entry.error = Some(error.to_owned());
        self.persist(&entries);
        true
    }

    pub fn register_managed_codex_target(
        &self,
        delegation_id: &str,
        worktree_path: &str,
        pane_id: &str,
        thread_id: &str,
        app_server: &str,
    ) -> bool {
        if thread_id.trim().is_empty() || app_server.trim().is_empty() {
            return false;
        }
        if !crate::codex_app_server::is_managed_remote(app_server) {
            return false;
        }
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let Some(entry) = entries.get_mut(delegation_id) else {
            return false;
        };
        if entry.worktree_path != worktree_path
            || entry
                .pane_id
                .as_deref()
                .is_some_and(|registered| registered != pane_id)
            || entry
                .target_thread_id
                .as_deref()
                .is_some_and(|registered| registered != thread_id)
        {
            return false;
        }
        entry.pane_id = Some(pane_id.to_owned());
        entry.target_app_server = Some(app_server.to_owned());
        entry.target_thread_id = Some(thread_id.to_owned());
        entry.target_turn_id = None;
        self.persist(&entries);
        true
    }

    fn managed_codex_target_for_hook(
        &self,
        thread_id: &str,
        cwd: &str,
    ) -> Option<(String, String)> {
        let entries = self.entries.lock().ok()?;
        entries.values().find_map(|entry| {
            (entry.target_thread_id.as_deref() == Some(thread_id)
                && entry
                    .target_app_server
                    .as_deref()
                    .is_some_and(crate::codex_app_server::is_managed_remote)
                && entry.worktree_path == cwd)
                .then(|| Some((entry.worktree_path.clone(), entry.pane_id.clone()?)))?
        })
    }

    fn claim_completion(entry: &mut AgentDelegation) -> Option<AgentCompletionNotification> {
        if entry.completion_notified || entry.completion_notification_in_flight {
            return None;
        }
        let thread_id = entry.source_thread_id.clone()?;
        let app_server = entry.source_app_server.clone()?;
        entry.completion_notification_in_flight = true;
        let label = entry.name.as_deref().unwrap_or("Agent tab");
        let outcome = match entry.error.as_deref() {
            Some(error) => format!("failed: {error}"),
            None => "finished and is now idle".to_string(),
        };
        Some(AgentCompletionNotification {
            delegation_id: entry.delegation_id.clone(),
            thread_id,
            app_server,
            prompt: format!(
                "Impala agent tab \"{label}\" {outcome}. Delegation id: {}. Inspect its changes and continue the delegated workflow.",
                entry.delegation_id
            ),
            target_worktree_path: entry.worktree_path.clone(),
            target_pane_id: entry.pane_id.clone(),
        })
    }

    pub fn claim_completion_for_delegation(
        &self,
        delegation_id: &str,
    ) -> Option<AgentCompletionNotification> {
        let mut entries = self.entries.lock().ok()?;
        let notification = Self::claim_completion(entries.get_mut(delegation_id)?)?;
        self.persist(&entries);
        Some(notification)
    }

    pub fn claim_completion_for_pane(
        &self,
        worktree_path: &str,
        pane_id: &str,
    ) -> Option<AgentCompletionNotification> {
        let mut entries = self.entries.lock().ok()?;
        let entry = entries.values_mut().find(|entry| {
            entry.worktree_path == worktree_path && entry.pane_id.as_deref() == Some(pane_id)
        })?;
        let notification = Self::claim_completion(entry)?;
        self.persist(&entries);
        Some(notification)
    }

    pub fn claim_pending_completions(
        &self,
        pane_statuses: &AgentPaneStatuses,
    ) -> Vec<AgentCompletionNotification> {
        let Ok(mut entries) = self.entries.lock() else {
            return Vec::new();
        };
        let notifications: Vec<_> = entries
            .values_mut()
            .filter(|entry| matches!(Self::status_for(entry, pane_statuses), "idle" | "failed"))
            .filter_map(Self::claim_completion)
            .collect();
        if !notifications.is_empty() {
            self.persist(&entries);
        }
        notifications
    }

    fn claim_managed_completions_with<F>(
        &self,
        pane_statuses: &AgentPaneStatuses,
        mut read_progress: F,
    ) -> Vec<AgentCompletionNotification>
    where
        F: FnMut(&str, &str) -> Result<crate::codex_app_server::ManagedThreadProgress, String>,
    {
        let candidates: Vec<_> = {
            let Ok(entries) = self.entries.lock() else {
                return Vec::new();
            };
            entries
                .values()
                .filter(|entry| {
                    entry.error.is_none()
                        && !entry.completion_notified
                        && !entry.completion_notification_in_flight
                        && entry.source_thread_id.is_some()
                        && entry.source_app_server.is_some()
                })
                .filter_map(|entry| {
                    let app_server = entry.target_app_server.as_deref()?;
                    crate::codex_app_server::is_managed_remote(app_server).then_some((
                        entry.delegation_id.clone(),
                        entry.target_thread_id.clone()?,
                        entry.target_turn_id.clone()?,
                        app_server.to_owned(),
                    ))
                })
                .collect()
        };

        let terminal: Vec<_> = candidates
            .into_iter()
            .filter_map(|(delegation_id, thread_id, turn_id, app_server)| {
                let progress = read_progress(&app_server, &thread_id).ok()?;
                if progress.turn_id.as_deref() != Some(turn_id.as_str()) {
                    return None;
                }
                let error = match progress.turn_status.as_deref() {
                    Some("completed") => None,
                    Some("failed") | Some("interrupted") => {
                        Some(progress.turn_error.unwrap_or_else(|| {
                            format!(
                                "managed Codex turn {}",
                                progress.turn_status.unwrap_or_default()
                            )
                        }))
                    }
                    _ if progress.thread_status == "systemError" => {
                        Some(progress.turn_error.unwrap_or_else(|| {
                            "managed Codex thread entered a system error".to_string()
                        }))
                    }
                    _ => return None,
                };
                Some((delegation_id, thread_id, turn_id, app_server, error))
            })
            .collect();

        if terminal.is_empty() {
            return Vec::new();
        }
        let Ok(mut entries) = self.entries.lock() else {
            return Vec::new();
        };
        let mut notifications = Vec::new();
        for (delegation_id, thread_id, turn_id, app_server, error) in terminal {
            let Some(entry) = entries.get_mut(&delegation_id) else {
                continue;
            };
            if entry.target_thread_id.as_deref() != Some(thread_id.as_str())
                || entry.target_turn_id.as_deref() != Some(turn_id.as_str())
                || entry.target_app_server.as_deref() != Some(app_server.as_str())
            {
                continue;
            }
            if let Some(error) = error {
                entry.error = Some(error);
            }
            if let Some(notification) = Self::claim_completion(entry) {
                notifications.push(notification);
            }
        }
        if !notifications.is_empty() {
            self.persist(&entries);
        }
        drop(entries);
        for notification in &notifications {
            if let Some(pane_id) = notification.target_pane_id.as_deref() {
                pane_statuses.observe(&notification.target_worktree_path, pane_id, "idle");
            }
        }
        notifications
    }

    pub fn claim_managed_completions(
        &self,
        pane_statuses: &AgentPaneStatuses,
    ) -> Vec<AgentCompletionNotification> {
        self.claim_managed_completions_with(
            pane_statuses,
            crate::codex_app_server::read_managed_thread_progress,
        )
    }

    /// `settled` means the wake needs no further attempt — delivered, or
    /// refused for good. Anything else stays claimable by the reconciler.
    fn finish_completion_notification(&self, delegation_id: &str, settled: bool) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let Some(entry) = entries.get_mut(delegation_id) else {
            return;
        };
        entry.completion_notification_in_flight = false;
        entry.completion_notified |= settled;
        self.persist(&entries);
    }

    fn observe_hook(
        &self,
        worktree_path: &str,
        pane_id: &str,
        pane_statuses: &AgentPaneStatuses,
        status: &str,
    ) -> String {
        // Publish the pane state first so a started delegation can never look idle.
        let aggregate_status = pane_statuses.observe(worktree_path, pane_id, status);
        let Ok(mut entries) = self.entries.lock() else {
            return aggregate_status;
        };
        let Some(entry) = entries.values_mut().find(|entry| {
            entry.worktree_path == worktree_path && entry.pane_id.as_deref() == Some(pane_id)
        }) else {
            return aggregate_status;
        };
        if !entry.started {
            entry.started = true;
            entry.end_tree = None;
            self.persist(&entries);
        }
        aggregate_status
    }

    fn change_refs(
        &self,
        worktree_path: &str,
        pane_id: &str,
    ) -> Result<Option<AgentRunChangeRefs>, String> {
        let (name, start_tree, frozen_end) = {
            let entries = self
                .entries
                .lock()
                .map_err(|_| "delegation registry is unavailable".to_string())?;
            let Some(entry) = entries.values().find(|entry| {
                entry.worktree_path == worktree_path && entry.pane_id.as_deref() == Some(pane_id)
            }) else {
                return Ok(None);
            };
            let Some(start_tree) = entry.start_tree.clone() else {
                return Ok(None);
            };
            (entry.name.clone(), start_tree, entry.end_tree.clone())
        };
        let finished = frozen_end.is_some();
        let end_tree = match frozen_end {
            Some(tree) => tree,
            None => crate::git::snapshot_worktree(worktree_path)?,
        };
        Ok(Some(AgentRunChangeRefs {
            worktree_path: worktree_path.to_owned(),
            pane_id: pane_id.to_owned(),
            name,
            start_tree,
            end_tree,
            finished,
        }))
    }

    pub fn change_summary(
        &self,
        worktree_path: &str,
        pane_id: &str,
    ) -> Result<Option<AgentRunChangeSummary>, String> {
        let Some(change_refs) = self.change_refs(worktree_path, pane_id)? else {
            return Ok(None);
        };
        let stat = crate::git::get_tree_diff_stat(
            &change_refs.worktree_path,
            &change_refs.start_tree,
            &change_refs.end_tree,
        )?;
        Ok(Some(AgentRunChangeSummary {
            worktree_path: change_refs.worktree_path,
            pane_id: change_refs.pane_id,
            name: change_refs.name,
            files: stat.files,
            additions: stat.additions,
            deletions: stat.deletions,
            finished: change_refs.finished,
        }))
    }

    pub fn changes(
        &self,
        worktree_path: &str,
        pane_id: &str,
    ) -> Result<Option<AgentRunChanges>, String> {
        let Some(change_refs) = self.change_refs(worktree_path, pane_id)? else {
            return Ok(None);
        };
        let stat = crate::git::get_tree_diff_stat(
            &change_refs.worktree_path,
            &change_refs.start_tree,
            &change_refs.end_tree,
        )?;
        let changed_files = crate::git::get_tree_changed_files(
            &change_refs.worktree_path,
            &change_refs.start_tree,
            &change_refs.end_tree,
        )?;
        let diff = crate::git::get_tree_diff(
            &change_refs.worktree_path,
            &change_refs.start_tree,
            &change_refs.end_tree,
        )?;
        let content_ref = change_refs.end_tree.clone();
        Ok(Some(AgentRunChanges {
            summary: AgentRunChangeSummary {
                worktree_path: change_refs.worktree_path,
                pane_id: change_refs.pane_id,
                name: change_refs.name,
                files: stat.files,
                additions: stat.additions,
                deletions: stat.deletions,
                finished: change_refs.finished,
            },
            changed_files,
            diff,
            content_ref,
        }))
    }

    pub fn finish(
        &self,
        worktree_path: &str,
        pane_id: &str,
    ) -> Result<Option<AgentRunChangeSummary>, String> {
        {
            let entries = self
                .entries
                .lock()
                .map_err(|_| "delegation registry is unavailable".to_string())?;
            let Some(entry) = entries.values().find(|entry| {
                entry.worktree_path == worktree_path && entry.pane_id.as_deref() == Some(pane_id)
            }) else {
                return Ok(None);
            };
            if !entry.started || entry.end_tree.is_some() || entry.start_tree.is_none() {
                return Ok(None);
            }
        }

        let end_tree = crate::git::snapshot_worktree(worktree_path)?;
        {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "delegation registry is unavailable".to_string())?;
            let Some(entry) = entries.values_mut().find(|entry| {
                entry.worktree_path == worktree_path && entry.pane_id.as_deref() == Some(pane_id)
            }) else {
                return Ok(None);
            };
            if entry.end_tree.is_some() {
                return Ok(None);
            }
            entry.end_tree = Some(end_tree);
            self.persist(&entries);
        }
        self.change_summary(worktree_path, pane_id)
    }

    fn status_for(entry: &AgentDelegation, pane_statuses: &AgentPaneStatuses) -> &'static str {
        if entry.error.is_some() {
            "failed"
        } else if !entry.started {
            "pending"
        } else {
            match entry
                .pane_id
                .as_deref()
                .and_then(|pane_id| pane_statuses.status(&entry.worktree_path, pane_id))
            {
                Some(value) if value == "working" => "running",
                Some(value) if value == "permission" => "waiting",
                _ => "idle",
            }
        }
    }

    pub fn status(
        &self,
        delegation_id: &str,
        pane_statuses: &AgentPaneStatuses,
    ) -> Result<AgentDelegationStatus, String> {
        if delegation_id.trim().is_empty() {
            return Err("missing delegation_id".to_string());
        }
        let entry = self
            .entries
            .lock()
            .map_err(|_| "delegation registry is unavailable".to_string())?
            .get(delegation_id)
            .cloned()
            .ok_or_else(|| format!("delegation not found: {delegation_id}"))?;
        let pane_status = Self::status_for(&entry, pane_statuses).to_string();
        let managed_target = match (
            entry.target_thread_id.as_deref(),
            entry.target_app_server.as_deref(),
        ) {
            (Some(thread_id), Some(app_server))
                if crate::codex_app_server::is_managed_remote(app_server) =>
            {
                Some((thread_id.to_string(), app_server.to_string()))
            }
            _ => None,
        };
        let (app_server_progress, progress_error) = match managed_target.as_ref() {
            Some((thread_id, app_server)) => {
                match crate::codex_app_server::read_managed_thread_progress(app_server, thread_id) {
                    Ok(progress) => (Some(progress), None),
                    Err(error) => (None, Some(error)),
                }
            }
            None => (None, None),
        };
        let status = if entry.error.is_some() {
            "failed"
        } else {
            match app_server_progress
                .as_ref()
                .and_then(|progress| progress.turn_status.as_deref())
            {
                Some("inProgress") if pane_status == "waiting" => "waiting",
                Some("inProgress") => "running",
                Some("completed") => "completed",
                Some("failed") => "failed",
                Some("interrupted") => "interrupted",
                _ if app_server_progress
                    .as_ref()
                    .is_some_and(|progress| progress.thread_status == "systemError") =>
                {
                    "failed"
                }
                _ => pane_status.as_str(),
            }
        }
        .to_string();
        let transport = if managed_target.is_some() {
            "app-server"
        } else {
            "pty"
        }
        .to_string();
        let can_steer = transport == "app-server"
            && status == "running"
            && pane_status == "running"
            && (entry
                .target_turn_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
                || app_server_progress
                    .as_ref()
                    .and_then(|progress| progress.turn_id.as_deref())
                    .is_some_and(|id| !id.is_empty()));
        let can_follow_up =
            pane_status == "idle" && entry.pane_id.as_deref().is_some_and(|id| !id.is_empty());
        Ok(AgentDelegationStatus {
            delegation_id: entry.delegation_id,
            name: entry.name,
            worktree_path: entry.worktree_path,
            pane_id: entry.pane_id,
            created_at: entry.created_at,
            status,
            pane_status,
            error: entry.error,
            callback_registered: entry.source_thread_id.is_some()
                && entry.source_app_server.is_some(),
            transport,
            thread_id: entry.target_thread_id,
            app_server_progress,
            progress_error,
            can_steer,
            can_follow_up,
        })
    }

    #[cfg(test)]
    fn test_status(
        &self,
        delegation_id: &str,
        pane_statuses: &AgentPaneStatuses,
    ) -> Option<(String, Option<String>)> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(delegation_id)?;
        Some((
            Self::status_for(entry, pane_statuses).to_owned(),
            entry.error.clone(),
        ))
    }

    pub fn fail_nonterminal_pane(
        &self,
        worktree_path: &str,
        pane_id: &str,
        pane_statuses: &AgentPaneStatuses,
        error: &str,
    ) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let Some(entry) = entries.values_mut().find(|entry| {
            entry.worktree_path == worktree_path && entry.pane_id.as_deref() == Some(pane_id)
        }) else {
            return false;
        };
        if matches!(Self::status_for(entry, pane_statuses), "idle" | "failed") {
            return false;
        }
        entry.error = Some(error.to_owned());
        self.persist(&entries);
        true
    }

    pub fn fail_nonterminal_worktree(
        &self,
        worktree_path: &str,
        pane_statuses: &AgentPaneStatuses,
        error: &str,
    ) -> usize {
        let Ok(mut entries) = self.entries.lock() else {
            return 0;
        };
        let mut failed = 0;
        for entry in entries
            .values_mut()
            .filter(|entry| entry.worktree_path == worktree_path)
        {
            if !matches!(Self::status_for(entry, pane_statuses), "idle" | "failed") {
                entry.error = Some(error.to_owned());
                failed += 1;
            }
        }
        if failed > 0 {
            self.persist(&entries);
        }
        failed
    }

    fn begin_follow_up(
        &self,
        delegation_id: &str,
        pane_statuses: &AgentPaneStatuses,
    ) -> Result<AgentFollowUpTarget, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "delegation registry is unavailable".to_string())?;
        let entry = entries
            .get_mut(delegation_id)
            .ok_or_else(|| format!("delegation not found: {delegation_id}"))?;
        let status = Self::status_for(entry, pane_statuses);
        if status != "idle" {
            return Err(format!(
                "delegation is {}; follow-ups require an idle tab",
                status
            ));
        }
        let pane_id = entry
            .pane_id
            .clone()
            .ok_or_else(|| "delegation has no registered pane".to_string())?;
        let target = match (&entry.target_thread_id, &entry.target_app_server) {
            (Some(thread_id), Some(app_server)) => {
                if !crate::codex_app_server::is_managed_remote(app_server) {
                    return Err("delegation target app-server is not Impala-managed".to_string());
                }
                AgentFollowUpTarget::ManagedCodex {
                    thread_id: thread_id.clone(),
                    app_server: app_server.clone(),
                }
            }
            (None, None) => AgentFollowUpTarget::Pty {
                worktree_path: entry.worktree_path.clone(),
                pane_id,
            },
            _ => {
                return Err(
                    "delegation has an inconsistent managed Codex target identity".to_string(),
                )
            }
        };
        entry.started = false;
        entry.completion_notified = false;
        entry.completion_notification_in_flight = false;
        self.persist(&entries);
        Ok(target)
    }

    fn begin_steer(
        &self,
        delegation_id: &str,
        pane_statuses: &AgentPaneStatuses,
    ) -> Result<AgentSteerTarget, String> {
        let (thread_id, app_server, recorded_turn_id) = {
            let entries = self
                .entries
                .lock()
                .map_err(|_| "delegation registry is unavailable".to_string())?;
            let entry = entries
                .get(delegation_id)
                .ok_or_else(|| format!("delegation not found: {delegation_id}"))?;
            let status = Self::status_for(entry, pane_statuses);
            if status != "running" {
                return Err(format!(
                    "delegation is {}; steering requires a running managed Codex tab",
                    status
                ));
            }
            let thread_id = entry
                .target_thread_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "delegation has no managed Codex target thread".to_string())?;
            let app_server = entry
                .target_app_server
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "delegation has no managed Codex target app-server".to_string())?;
            (
                thread_id.to_owned(),
                app_server.to_owned(),
                entry.target_turn_id.clone(),
            )
        };
        if !crate::codex_app_server::is_managed_remote(&app_server) {
            return Err("delegation target app-server is not Impala-managed".to_string());
        }
        let turn_id = match recorded_turn_id.filter(|turn_id| !turn_id.trim().is_empty()) {
            Some(turn_id) => turn_id,
            None => {
                let progress =
                    crate::codex_app_server::read_managed_thread_progress(&app_server, &thread_id)?;
                if progress.turn_status.as_deref() != Some("inProgress") {
                    return Err("delegation has no active managed Codex turn".to_string());
                }
                progress
                    .turn_id
                    .ok_or_else(|| "delegation has no active managed Codex turn".to_string())?
            }
        };
        Ok(AgentSteerTarget {
            thread_id,
            app_server,
            turn_id,
        })
    }

    pub fn record_managed_turn(
        &self,
        delegation_id: &str,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<(), String> {
        if turn_id.trim().is_empty() {
            return Err("Codex turn/start returned no turn id".to_string());
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "delegation registry is unavailable".to_string())?;
        let entry = entries
            .get_mut(delegation_id)
            .ok_or_else(|| format!("delegation not found: {delegation_id}"))?;
        if entry.target_thread_id.as_deref() != Some(thread_id) {
            return Err(
                "delegation managed Codex target changed while starting follow-up".to_string(),
            );
        }
        entry.target_turn_id = Some(turn_id.to_owned());
        self.persist(&entries);
        Ok(())
    }

    pub fn cancel_follow_up(&self, delegation_id: &str) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let Some(entry) = entries.get_mut(delegation_id) else {
            return;
        };
        entry.started = true;
        entry.completion_notified = true;
        entry.completion_notification_in_flight = false;
        self.persist(&entries);
    }
}

impl Default for AgentDelegations {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            persist: false,
        }
    }
}

impl Default for AgentPaneStatuses {
    fn default() -> Self {
        Self {
            panes: Mutex::new(HashMap::new()),
            persist: false,
        }
    }
}

/// The app server has no record of the thread to wake. Unlike a busy turn,
/// waiting can't fix it — and the reconciler re-claims an unsettled
/// notification every 2s, so retrying one is a loop with no exit.
fn wake_target_is_gone(error: &str) -> bool {
    error.contains("thread not found")
}

pub fn dispatch_completion(
    delegations: Arc<AgentDelegations>,
    notification: AgentCompletionNotification,
) {
    std::thread::spawn(move || {
        let mut last_error = None;
        // A very fast worker can finish while the originating turn is still
        // returning from open_agent_tab. Retry until that turn becomes idle.
        for _ in 0..150 {
            match crate::codex_app_server::start_turn(
                &notification.app_server,
                &notification.thread_id,
                &format!("impala-agent-completion:{}", notification.delegation_id),
                &notification.prompt,
            ) {
                Ok(_) => {
                    delegations.finish_completion_notification(&notification.delegation_id, true);
                    return;
                }
                Err(error) if wake_target_is_gone(&error) => {
                    // Settle it: nobody is left to notify, so stop rather
                    // than burn a 5-minute retry per reconciler tick.
                    delegations.finish_completion_notification(&notification.delegation_id, true);
                    eprintln!(
                        "[impala] dropped Codex wake for delegation {}: {}",
                        notification.delegation_id, error
                    );
                    return;
                }
                Err(error) => last_error = Some(error),
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        delegations.finish_completion_notification(&notification.delegation_id, false);
        eprintln!(
            "[impala] failed to wake Codex thread for delegation {}: {}",
            notification.delegation_id,
            last_error.as_deref().unwrap_or("unknown app-server error")
        );
    });
}

pub fn start_managed_completion_reconciler(
    app: AppHandle,
    statuses: Arc<AgentStatuses>,
    pane_statuses: Arc<AgentPaneStatuses>,
    delegations: Arc<AgentDelegations>,
) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        loop {
            interval.tick().await;
            let pending = tokio::task::spawn_blocking({
                let pane_statuses = pane_statuses.clone();
                let delegations = delegations.clone();
                move || delegations.claim_managed_completions(&pane_statuses)
            })
            .await;
            let Ok(notifications) = pending else {
                continue;
            };
            for notification in notifications {
                let Some(target_pane_id) = notification.target_pane_id.as_deref() else {
                    dispatch_completion(delegations.clone(), notification);
                    continue;
                };
                match delegations.finish(&notification.target_worktree_path, target_pane_id) {
                    Ok(Some(summary)) if summary.files > 0 => {
                        let _ = app.emit("agent-run-changes-completed", summary);
                    }
                    Ok(_) => {}
                    Err(error) => eprintln!(
                        "[impala] delegated agent completion snapshot failed for {}: {}",
                        notification.target_worktree_path, error
                    ),
                }
                publish_agent_pane_event(
                    &app,
                    &notification.target_worktree_path,
                    target_pane_id,
                    "idle",
                );
                let aggregate_status = pane_statuses
                    .aggregate_snapshot()
                    .remove(&notification.target_worktree_path)
                    .unwrap_or_else(|| "idle".to_string());
                publish_agent_status(
                    &app,
                    &statuses,
                    &notification.target_worktree_path,
                    &aggregate_status,
                );
                dispatch_completion(delegations.clone(), notification);
            }
        }
    });
}

pub struct InterruptedAgentTurns {
    panes: Mutex<HashSet<(String, String)>>,
    persist: bool,
}

impl InterruptedAgentTurns {
    pub fn load_persisted() -> Self {
        let keys: Vec<AgentPaneKey> =
            read_runtime_state("interrupted-agent-turns.json").unwrap_or_default();
        Self {
            panes: Mutex::new(
                keys.into_iter()
                    .map(|key| (key.worktree_path, key.pane_id))
                    .collect(),
            ),
            persist: true,
        }
    }

    fn persist(&self, panes: &HashSet<(String, String)>) {
        if !self.persist {
            return;
        }
        let keys: Vec<_> = panes
            .iter()
            .map(|(worktree_path, pane_id)| AgentPaneKey {
                worktree_path: worktree_path.clone(),
                pane_id: pane_id.clone(),
            })
            .collect();
        write_runtime_state("interrupted-agent-turns.json", &keys);
    }

    pub fn mark(&self, worktree_path: &str, pane_id: &str) {
        if let Ok(mut panes) = self.panes.lock() {
            panes.insert((worktree_path.to_owned(), pane_id.to_owned()));
            self.persist(&panes);
        }
    }

    fn suppresses(&self, worktree_path: &str, pane_id: &str, event_type: &str) -> bool {
        let Ok(mut panes) = self.panes.lock() else {
            return false;
        };
        let key = (worktree_path.to_owned(), pane_id.to_owned());
        if matches!(event_type, "SessionStart" | "UserPromptSubmit") {
            panes.remove(&key);
            self.persist(&panes);
            return false;
        }
        panes.contains(&key)
    }
}

impl Default for InterruptedAgentTurns {
    fn default() -> Self {
        Self {
            panes: Mutex::new(HashSet::new()),
            persist: false,
        }
    }
}

/// Status a hook event implies for its pane. `pane_is_active` is whether the
/// pane currently has a non-idle status: a backgrounded tool's PostToolUse
/// can arrive after the turn's Stop, and must drain silently rather than
/// resurrect a pane whose agent already went idle — no later event would
/// ever clear it. New turns always open with UserPromptSubmit, PreToolUse,
/// or PermissionRequest, so only those may raise status from scratch.
fn pane_status_for_hook_event(
    event_type: &str,
    automation_should_complete: bool,
    stop_with_active_tools: bool,
    pane_is_active: bool,
) -> &'static str {
    match event_type {
        "UserPromptSubmit" | "PreToolUse" => {
            if automation_should_complete {
                "idle"
            } else {
                "working"
            }
        }
        "PostToolUse" | "PostToolUseFailure" => {
            if automation_should_complete {
                "idle"
            } else if pane_is_active {
                "working"
            } else {
                ""
            }
        }
        "Stop" => {
            if stop_with_active_tools {
                "working"
            } else {
                "idle"
            }
        }
        "PermissionRequest" => "permission",
        _ => "",
    }
}

#[derive(Deserialize, Serialize)]
struct AgentPaneKey {
    worktree_path: String,
    pane_id: String,
}

/// Per-worktree git tree sha captured when the user submits a prompt. Powers
/// the "Last turn" diff view. Persists in memory until the next prompt
/// replaces it; lost on app restart (acceptable — rebuilds on next turn).
pub struct LastTurnSnapshots(pub Mutex<HashMap<String, String>>);

#[derive(Clone, Serialize)]
pub struct AgentStatusEvent {
    pub worktree_path: String,
    pub status: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct AgentPaneStatusEvent {
    pub worktree_path: String,
    pub pane_id: String,
    pub status: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct AutomationTurnActivity {
    turn_id: Option<String>,
    active_tool_ids: HashSet<String>,
    stop_seen: bool,
}

/// A Stop hook means the lead turn stopped, but Codex may still have yielded
/// shell tools running in the background. Keep the run active until every
/// PreToolUse has a matching PostToolUse/PostToolUseFailure.
#[derive(Default)]
struct AutomationCompletionTracker {
    turns: HashMap<(String, String), AutomationTurnActivity>,
    persist: bool,
}

impl AutomationCompletionTracker {
    fn load_persisted() -> Self {
        let turns: Vec<PersistedAutomationTurn> =
            read_runtime_state("automation-turns.json").unwrap_or_default();
        Self {
            turns: turns
                .into_iter()
                .map(|turn| ((turn.worktree_path, turn.pane_id), turn.activity))
                .collect(),
            persist: true,
        }
    }

    fn persist(&self) {
        if !self.persist {
            return;
        }
        let turns: Vec<_> = self
            .turns
            .iter()
            .map(
                |((worktree_path, pane_id), activity)| PersistedAutomationTurn {
                    worktree_path: worktree_path.clone(),
                    pane_id: pane_id.clone(),
                    activity: activity.clone(),
                },
            )
            .collect();
        write_runtime_state("automation-turns.json", &turns);
    }

    fn observe(
        &mut self,
        worktree_path: &str,
        pane_id: &str,
        event_type: &str,
        payload: &str,
    ) -> bool {
        let key = (worktree_path.to_owned(), pane_id.to_owned());
        let payload: serde_json::Value =
            serde_json::from_str(payload).unwrap_or(serde_json::Value::Null);
        let turn_id = payload
            .get("turn_id")
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let tool_use_id = payload
            .get("tool_use_id")
            .and_then(|value| value.as_str())
            .map(str::to_owned);

        let should_complete = match event_type {
            "SessionStart" => {
                self.turns.remove(&key);
                false
            }
            "UserPromptSubmit" => {
                self.turns.insert(
                    key,
                    AutomationTurnActivity {
                        turn_id,
                        ..Default::default()
                    },
                );
                false
            }
            "PreToolUse" => {
                let activity = self.turns.entry(key).or_default();
                if activity.turn_id.is_none() {
                    activity.turn_id = turn_id;
                }
                if let Some(tool_use_id) = tool_use_id {
                    activity.active_tool_ids.insert(tool_use_id);
                }
                false
            }
            "PostToolUse" | "PostToolUseFailure" => {
                let Some(activity) = self.turns.get_mut(&key) else {
                    return false;
                };
                if let Some(tool_use_id) = tool_use_id {
                    activity.active_tool_ids.remove(&tool_use_id);
                }
                let should_complete = activity.stop_seen && activity.active_tool_ids.is_empty();
                if should_complete {
                    self.turns.remove(&key);
                }
                should_complete
            }
            "Stop" => {
                let Some(activity) = self.turns.get_mut(&key) else {
                    // After a hook-server restart we cannot prove that an
                    // already-running turn has no background tools. Keep its
                    // automation launched instead of reporting false success.
                    return false;
                };
                if activity.turn_id.is_some() && turn_id.is_some() && activity.turn_id != turn_id {
                    return false;
                }
                activity.stop_seen = true;
                let should_complete = activity.active_tool_ids.is_empty();
                if should_complete {
                    self.turns.remove(&key);
                }
                should_complete
            }
            _ => false,
        };
        self.persist();
        should_complete
    }

    fn has_active_tools(&self, worktree_path: &str, pane_id: &str) -> bool {
        self.turns
            .get(&(worktree_path.to_owned(), pane_id.to_owned()))
            .map(|activity| !activity.active_tool_ids.is_empty())
            .unwrap_or(false)
    }
}

#[derive(Deserialize, Serialize)]
struct PersistedAutomationTurn {
    worktree_path: String,
    pane_id: String,
    activity: AutomationTurnActivity,
}

#[derive(Clone, Serialize)]
pub struct LastTurnSnapshotEvent {
    pub worktree_path: String,
}

pub fn hook_command_for_provider_public(event_type: &str, provider: &str) -> String {
    hook_command(event_type).replace("${IMPALA_AGENT_PROVIDER:-}", provider)
}

/// The hook command for a specific event type. The app-server hook process
/// does not inherit the terminal pane environment, so Codex identity comes
/// only from its JSON body. It still prefers a reachable inherited port for
/// local sessions that outlive a second Impala instance. Stdin must be drained first:
/// the agent writes the full event payload to hook stdin, and a PostToolUse
/// payload carrying a browser screenshot exceeds the 64KB pipe buffer — a
/// command that exits without reading gives the agent a broken-pipe error.
/// Stdout is fully suppressed: Codex parses hook stdout as JSON and chokes
/// on non-JSON bodies (Claude Code ignores stdout entirely), so we make
/// sure neither sees the HTTP response body.
fn hook_command(event_type: &str) -> String {
    format!(
        "IMPALA_INHERITED_HOOK_PORT=\"${{IMPALA_HOOK_PORT:-}}\"; IMPALA_DISCOVERED_HOOK_PORT=$(cat ~/.impala/hook-port 2>/dev/null); if [ -n \"$IMPALA_INHERITED_HOOK_PORT\" ] && curl -sS \"http://127.0.0.1:${{IMPALA_INHERITED_HOOK_PORT}}/\" --connect-timeout 1 --max-time 1 >/dev/null 2>&1; then IMPALA_HOOK_PORT=\"$IMPALA_INHERITED_HOOK_PORT\"; else IMPALA_HOOK_PORT=\"$IMPALA_DISCOVERED_HOOK_PORT\"; fi; if [ -n \"$IMPALA_HOOK_PORT\" ]; then curl -sS -X POST \"http://127.0.0.1:${{IMPALA_HOOK_PORT}}/hook\" --url-query \"event_type={}\" --url-query \"worktree_path=${{IMPALA_WORKTREE_PATH:-}}\" --url-query \"pane_id=${{IMPALA_PANE_ID:-}}\" --url-query \"agent_provider=${{IMPALA_AGENT_PROVIDER:-}}\" --data-binary @- --connect-timeout 1 --max-time 2 >/dev/null 2>&1; else cat >/dev/null 2>&1; fi; true",
        event_type
    )
}

/// Pane identities recorded at PTY spawn, keyed by PTY session id. Codex
/// app-server sessions execute hooks daemon-side, where the per-pane env vars
/// never exist — this registry lets the hook server recover (worktree, pane)
/// for such hooks from the payload's cwd. PTY session ids are deterministic,
/// and all launch/session attribution is scoped to the current app run.
#[derive(Default)]
pub struct PaneRegistry(Mutex<PaneRegistryState>);

#[derive(Default)]
struct PaneRegistryState {
    panes: HashMap<String, PaneIdentity>,
    pending_codex_launches: HashMap<String, VecDeque<PendingCodexLaunch>>,
    codex_sessions: HashMap<(String, String), String>,
}

struct PendingCodexLaunch {
    pane_id: String,
    recorded_at: i64,
}

struct PaneIdentity {
    worktree_path: String,
    pane_id: String,
    provider: String,
}

#[derive(Deserialize)]
struct PersistedCodexPane {
    worktree_path: String,
    pane_id: String,
    provider: String,
}

impl PaneRegistry {
    pub fn load_persisted() -> Self {
        Self::from_persisted(read_runtime_state("subagent-sessions.json").unwrap_or_default())
    }

    fn from_persisted(entries: Vec<PersistedCodexPane>) -> Self {
        let panes = entries
            .into_iter()
            .filter(|entry| {
                entry.provider == "codex"
                    && !entry.worktree_path.is_empty()
                    && !entry.pane_id.is_empty()
                    && Path::new(&entry.worktree_path).is_dir()
            })
            .map(|entry| {
                (
                    format!("pty-{}-{}", entry.pane_id, entry.worktree_path),
                    PaneIdentity {
                        worktree_path: entry.worktree_path,
                        pane_id: entry.pane_id,
                        provider: entry.provider,
                    },
                )
            })
            .collect();
        Self(Mutex::new(PaneRegistryState {
            panes,
            ..PaneRegistryState::default()
        }))
    }

    #[cfg(test)]
    fn record(&self, pty_session_id: &str, worktree_path: &str, pane_id: &str, provider: &str) {
        self.record_spawn(pty_session_id, worktree_path, pane_id, provider, false);
    }

    pub fn record_spawn(
        &self,
        pty_session_id: &str,
        worktree_path: &str,
        pane_id: &str,
        provider: &str,
        reattached: bool,
    ) {
        if worktree_path.is_empty() || pane_id.is_empty() {
            return;
        }
        if let Ok(mut state) = self.0.lock() {
            let identity = PaneIdentity {
                worktree_path: worktree_path.to_owned(),
                pane_id: pane_id.to_owned(),
                provider: provider.to_owned(),
            };
            if reattached {
                state
                    .panes
                    .entry(pty_session_id.to_owned())
                    .or_insert(identity);
            } else {
                state.panes.insert(pty_session_id.to_owned(), identity);
            }
        }
    }

    fn record_codex_launch(
        &self,
        worktree_path: &str,
        pane_id: &str,
        session_id: Option<&str>,
    ) -> bool {
        if worktree_path.is_empty() || pane_id.is_empty() {
            return false;
        }
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if let Some(session_id) = session_id.filter(|id| !id.is_empty()) {
            state.codex_sessions.insert(
                (worktree_path.to_owned(), session_id.to_owned()),
                pane_id.to_owned(),
            );
            return true;
        }
        let now = chrono::Utc::now().timestamp_millis();
        let queue = state
            .pending_codex_launches
            .entry(worktree_path.to_owned())
            .or_default();
        queue.retain(|launch| now - launch.recorded_at <= 30_000);
        if !queue.is_empty() {
            return false;
        }
        queue.push_back(PendingCodexLaunch {
            pane_id: pane_id.to_owned(),
            recorded_at: now,
        });
        true
    }

    /// The Codex pane an unattributed app-server hook belongs to. A wrapper
    /// announcement binds the new session first; legacy sessions retain the
    /// primary-pane fallback when the cwd alone is ambiguous.
    fn codex_pane_for_hook(&self, cwd: &str, session_id: Option<&str>) -> Option<(String, String)> {
        let mut state = self.0.lock().ok()?;
        if let Some(session_id) = session_id {
            if let Some(pane_id) = state
                .codex_sessions
                .get(&(cwd.to_owned(), session_id.to_owned()))
            {
                return Some((cwd.to_owned(), pane_id.clone()));
            }
        }

        let now = chrono::Utc::now().timestamp_millis();
        let pending = state.pending_codex_launches.get_mut(cwd).and_then(|queue| {
            while queue
                .front()
                .is_some_and(|launch| now - launch.recorded_at > 30_000)
            {
                queue.pop_front();
            }
            queue.pop_front()
        });
        if let Some(pending) = pending {
            if let Some(session_id) = session_id {
                state.codex_sessions.insert(
                    (cwd.to_owned(), session_id.to_owned()),
                    pending.pane_id.clone(),
                );
            }
            return Some((cwd.to_owned(), pending.pane_id));
        }

        let mut only: Option<&PaneIdentity> = None;
        for pane in state
            .panes
            .values()
            .filter(|pane| pane.provider == "codex" && pane.worktree_path == cwd)
        {
            if pane.pane_id == "tab-agent" {
                let target = (pane.worktree_path.clone(), pane.pane_id.clone());
                if let Some(session_id) = session_id {
                    state
                        .codex_sessions
                        .insert((cwd.to_owned(), session_id.to_owned()), target.1.clone());
                }
                return Some(target);
            }
            if only.is_some() {
                only = None;
                break;
            }
            only = Some(pane);
        }
        let target = only.map(|pane| (pane.worktree_path.clone(), pane.pane_id.clone()));
        if let (Some((_, pane_id)), Some(session_id)) = (&target, session_id) {
            state
                .codex_sessions
                .insert((cwd.to_owned(), session_id.to_owned()), pane_id.clone());
        }
        target
    }
}

fn hook_target_for_identity(
    delegations: &AgentDelegations,
    pane_registry: &PaneRegistry,
    params: &HashMap<String, String>,
    hook_identity: Option<&serde_json::Value>,
) -> ((String, String), String) {
    let session_id = hook_identity.and_then(|value| value["session_id"].as_str());
    let cwd = hook_identity.and_then(|value| value["cwd"].as_str());
    if let (Some(session_id), Some(cwd)) = (session_id, cwd) {
        if let Some(target) = delegations.managed_codex_target_for_hook(session_id, cwd) {
            return (target, "codex".to_string());
        }
    }
    let worktree_path = params.get("worktree_path").cloned().unwrap_or_default();
    let pane_id = params.get("pane_id").cloned().unwrap_or_default();
    // Empty identity params mean the hook ran outside a pane shell — for
    // Codex app-server sessions that's the daemon, whose env has no pane
    // vars. Recover the pane from the payload's cwd via the spawn registry.
    if worktree_path.is_empty() && pane_id.is_empty() {
        if let Some(cwd) = cwd {
            if let Some(target) = pane_registry.codex_pane_for_hook(cwd, session_id) {
                return (target, "codex".to_string());
            }
        }
    }
    (
        (worktree_path, pane_id),
        params.get("agent_provider").cloned().unwrap_or_default(),
    )
}

const IMPALA_REVIEW_SKILL: &str = r#"---
name: impala-review
description: Review and address code review annotations from Impala. Use when asked to review annotations, or when invoked as /impala-review.
allowed-tools: mcp__impala__list_annotations, mcp__impala__resolve_annotation, mcp__impala__list_files_with_annotations, mcp__impala__get_browser_annotation_screenshot, mcp__impala__browser_navigate, mcp__impala__browser_click, mcp__impala__browser_click_at, mcp__impala__browser_scroll, mcp__impala__browser_type, mcp__impala__browser_screenshot, mcp__impala__browser_console, mcp__impala__browser_page_info, Read, Edit, Write, Grep, Glob
argument-hint: "[annotation-id]"
---

Review and address review annotations from Impala using the MCP server tools. These are human-written review comments. They come in two kinds (the `kind` field): `code` annotations anchored to specific lines in the code, and `browser` annotations anchored to an element in the rendered app (URL + CSS selector + screenshot), created by the reviewer clicking an element in Impala's browser pane.

ARGUMENTS: If an annotation ID is provided as an argument, address only that annotation. Otherwise, address all unresolved annotations.

## Phase 1: Fetch and Plan

1. Call `mcp__impala__list_files_with_annotations` to get an overview of which files have annotations and how many.
2. Call `mcp__impala__list_annotations` to fetch unresolved annotations. If an ID argument was given, find that specific annotation.
3. If zero annotations, report "No unresolved review comments. Nothing to address." and stop.
4. Group annotations by file — you will work through them file by file so you only need to read each file once.

## Phase 2: Triage Each Annotation

For each unresolved annotation, read the file at the annotated line and evaluate the comment. Classify it as one of:

### ACTIONABLE
The reviewer requests a concrete change — a bug fix, a refactor, a naming improvement, using a different API, etc. The right action is clear from the comment.

Examples:
- "Use plain tailwind classes instead of this wrapper"
- "This should return an object, not void"
- "Never use plain buttons, always use from components"
- "Split this into multiple files"

### DISCUSSION
The reviewer raises a valid point, but the right approach is unclear or involves a tradeoff. The comment is a question, a suggestion to consider, or thinking out loud.

Examples:
- "Should these types be part of the store? It looks more component related"
- "Can't we use selectors or a better way for this?"
- "Do we need isMobile detection via a separate hook? Couldn't we just use tailwind for this?"

### ALREADY ADDRESSED
The concern has already been fixed in the current code, or is no longer relevant.

## Phase 3: Address Each Annotation

Work file by file. For each file, read it once, then process all annotations on that file before moving to the next.

After addressing each annotation, immediately call `mcp__impala__resolve_annotation` to mark it done.

**ACTIONABLE:** Fix the code, then resolve the annotation.

**DISCUSSION:** Before asking the user, explore the codebase to see if the answer is clear from context (existing patterns, conventions, usage elsewhere). If you can determine the right approach, treat it as ACTIONABLE instead.

If the question genuinely requires user input, present it well — ONE annotation per message:
1. Briefly explain why the reviewer's concern matters
2. List the realistic options with trade-offs
3. Give your recommended approach and why
4. Ask, then STOP and wait for their answer

Apply their decision, then resolve the annotation.

**ALREADY ADDRESSED:** Resolve the annotation immediately.

Keep fixes minimal and focused — don't refactor unrelated code. If a reviewer suggests a specific code change, prefer their version unless it introduces issues.

## Browser Annotations (kind: "browser")

These point at a rendered element, not a source line. For each one:

1. If `has_screenshot` is true, call `mcp__impala__get_browser_annotation_screenshot` with the annotation id to SEE the element the reviewer picked.
2. Locate the source: grep for the selector's distinctive parts (ids, class names, data-testids from `selector` and the `element` HTML snippet), and use the `url` path to identify the route/page component.
3. Make the change like any ACTIONABLE annotation.
4. **Verify visually**: call `mcp__impala__browser_navigate` to the annotation's `url` (the dev server must be running), then `mcp__impala__browser_screenshot` and confirm the change looks right. Check `mcp__impala__browser_console` if the page misbehaves.
5. Resolve the annotation.

## Phase 4: Verify

After all annotations are addressed, run the project's typecheck and lint to make sure nothing is broken. Fix any issues introduced by the changes.

## Phase 5: Summary

Report a structured summary:

```
## Review Annotations Summary

### Results
- Fixed: X annotations
- Already addressed: X
- Discussion resolved: X

### Changes
- <file>: <what was changed and why>
- <file>: <what was changed and why>
```

## Annotation Fields

- `id` — unique identifier, used for resolving
- `kind` — `code` or `browser`
- `body` — the reviewer's comment text
- `resolved` — boolean, only unresolved annotations are returned

Code annotations: `file_path`, `line_number`, and `side` (`left` = old/deleted code, `right` = new/added code).

Browser annotations: `url` (the page), `selector` (CSS path to the element), `element` (truncated outerHTML), `has_screenshot` (fetch it via `get_browser_annotation_screenshot`).

## Important Notes

- **Every annotation gets addressed** — no silent skips
- **Ask the user when uncertain** — don't guess on architectural or business logic questions
- **Verify before fixing** — read the code context, understand the intent, then act
- **Keep fixes minimal** — only change what the annotation asks for
- **Work file by file** — group annotations by file to avoid redundant file reads
"#;

const IMPALA_BROWSER_SKILL: &str = r#"---
name: impala-browser
description: Verify or diagnose the running app in Impala's built-in browser. Use only in an Impala-hosted agent session where the runtime guard succeeds. Never use this skill for browser work outside Impala.
allowed-tools: Bash(test:*), mcp__impala__browser_page_info, mcp__impala__browser_navigate, mcp__impala__browser_click, mcp__impala__browser_click_at, mcp__impala__browser_scroll, mcp__impala__browser_type, mcp__impala__browser_screenshot, mcp__impala__browser_console
---

Impala (the desktop app this worktree is open in) has a built-in browser pane next to the code, driven by the `mcp__impala__browser_*` tools. Prefer them over curl, Playwright, or headless browsers for anything the rendered page can answer — the user watches the same pane you're testing, so what you verify is what they see.

## Runtime guard

Before calling any `mcp__impala__browser_*` tool, run:

```sh
test -f ~/.impala/hook-port
```

If the command fails, stop using this skill and do not call any Impala browser tools. Tell the user that the Impala browser is available only while the Impala app is running. Do not substitute another browser unless the user asks.

(The check is a file, not an env var: Codex app-server sessions run commands daemon-side without Impala's per-pane environment; `~/.impala/hook-port` exists whenever the app is running and is the same fallback the MCP server uses.)

## The loop

1. `mcp__impala__browser_page_info` — is a browser pane open, and what page is it on?
2. `mcp__impala__browser_navigate` — go to the page you need (e.g. the dev-server route you changed). If the response has `created: true`, a new browser tab was created; its webview loads once the pane is visible in Impala, so tell the user to open it rather than retrying screenshots in a loop.
3. `mcp__impala__browser_click` — click a button, link, or tab by CSS selector when the flow needs interaction. Delivers real platform input (isTrusted: true with user activation — clipboard and native controls respond; new-window requests open as managed Impala browser tabs). A visible cursor glides to the target in the pane. Screenshot after to confirm what happened.
4. `mcp__impala__browser_type` — click-focuses the element by CSS selector, then types the text as real keystrokes (keydown/input events fire, so React/Vue and shortcut handlers register it; replaces the current value, empty string clears, newlines press Return).
5. `mcp__impala__browser_click_at` — click at raw viewport coordinates (CSS px, origin top-left) when no selector exists (canvas, maps). Pair with `browser_screenshot`; screenshots are captured at the display's scale factor, so divide screenshot pixels by (screenshot width / viewport width from `browser_page_info`).
6. `mcp__impala__browser_scroll` — scroll with a real wheel event at the viewport center (positive dy scrolls down; dx optional).
7. `mcp__impala__browser_screenshot` — SEE the rendered page. This is the ground truth for visual verification.
8. `mcp__impala__browser_console` — read console output, window errors, and unhandled rejections when the page misbehaves. Pass `clear: true` to drain, navigate again to reproduce, then read for a clean signal.

After making a fix, navigate again and screenshot — verify visually before declaring success.

## Notes

- Clicks are real input: they can open native OS dialogs (file pickers) that you cannot drive — tell the user when one is needed.
- The dev server must be running (usually Impala's Run tab). Connection failures render as a blank page with no error event — a blank screenshot plus an unreachable URL usually means the server is down.
- Console logs are captured per page; they reset on navigation.
- Screenshots show the pane's viewport, not the full scroll height.
- "no browser tab open for this worktree" → ask the user to open one (+ menu → New browser tab), or navigate to create it.
"#;

const IMPALA_AUTOMATIONS_SKILL: &str = r#"---
name: impala-automations
description: Schedule recurring agent runs in Impala. Use when the user asks for work on a schedule — "every morning", "daily", "check this weekly", "keep an eye on this" — or wants to list, edit, pause, resume, or trigger scheduled automations.
allowed-tools: mcp__impala__list_automations, mcp__impala__create_automation, mcp__impala__update_automation, mcp__impala__run_automation_now, mcp__impala__set_automation_enabled
---

Impala (the desktop app this worktree is open in) runs scheduled automations: name + prompt + schedule + agent, per project. At each fire Impala creates a fresh worktree, launches the agent with the prompt, and the finished run lands as a reviewable diff with a badge in the app. Runs fire only while Impala is open; a slot missed while it was closed fires once on next launch.

## Tools

- `mcp__impala__list_automations` — automations + recent runs for this project. Call this FIRST before creating; if a similar one exists, edit it with update_automation instead of stacking a duplicate.
- `mcp__impala__create_automation` — name, prompt, schedule; agent defaults to this worktree's agent.
- `mcp__impala__update_automation` — edit an existing automation by id; pass only the fields to change (name, prompt, schedule, agent). Changing the schedule recomputes the next run from now.
- `mcp__impala__run_automation_now` — trigger one run immediately (creates a real worktree; say so before doing it).
- `mcp__impala__set_automation_enabled` — pause (false) / resume (true). Resuming skips occurrences missed while paused.

## Schedules

5-field cron, evaluated in the machine's local timezone. Common shapes: `0 9 * * *` daily 9:00, `0 9 * * MON-FRI` weekday mornings, `0 17 * * FRI` Friday 17:00, `0 * * * *` hourly.

## Writing automation prompts

The prompt runs unattended in a fresh worktree with nobody there to answer questions, so make it self-contained and decisive: state exactly what to examine, what to change or produce, and where to put it. Have it write results into files (e.g. `docs/<topic>/<date>.md`) or make the fixes directly — the diff IS the deliverable the user reviews. Never write a prompt that only prints to the terminal.

When the user's request is ambiguous about cadence or scope ("keep an eye on this"), propose a concrete name + schedule + prompt and confirm before creating.
"#;

/// Install a skill to ~/.claude/skills/<name>/SKILL.md
fn install_skill(name: &str, content: &str) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };

    let skill_dir = home.join(".claude").join("skills").join(name);
    if std::fs::create_dir_all(&skill_dir).is_err() {
        return;
    }

    let _ = std::fs::write(skill_dir.join("SKILL.md"), content);
}

/// Install the Impala skills (/impala-review, /impala-browser,
/// /impala-automations) for Claude Code.
pub fn install_impala_review_skill() {
    install_skill("impala-review", IMPALA_REVIEW_SKILL);
    install_skill("impala-browser", IMPALA_BROWSER_SKILL);
    install_skill("impala-automations", IMPALA_AUTOMATIONS_SKILL);
}

pub fn publish_agent_status(
    app_handle: &AppHandle,
    statuses: &AgentStatuses,
    worktree_path: &str,
    status: &str,
) {
    if let Ok(mut map) = statuses.0.lock() {
        map.insert(worktree_path.to_owned(), status.to_owned());
    }
    let _ = app_handle.emit(
        "agent-status",
        AgentStatusEvent {
            worktree_path: worktree_path.to_owned(),
            status: status.to_owned(),
        },
    );
}

pub fn publish_agent_pane_event(
    app_handle: &AppHandle,
    worktree_path: &str,
    pane_id: &str,
    status: &str,
) {
    let _ = app_handle.emit(
        "agent-pane-status",
        AgentPaneStatusEvent {
            worktree_path: worktree_path.to_owned(),
            pane_id: pane_id.to_owned(),
            status: status.to_owned(),
        },
    );
}

/// Dispatch a /browser/* request. Every response is a JSON object with an
/// `ok` flag; errors carry `error`.
fn handle_browser_request(
    app: &AppHandle,
    path: &str,
    params: &HashMap<String, String>,
) -> serde_json::Value {
    // Surface agent activity in the UI (tab dot, toolbar chip, pane ring).
    // Every agent interaction flows through here; user-driven actions go
    // through tauri commands instead, so this is a clean attribution signal.
    if let Some(wt) = params.get("worktree_path").filter(|p| !p.is_empty()) {
        let kind = path.strip_prefix("/browser/").unwrap_or("unknown");
        let _ = app.emit_to(
            "main",
            "browser-agent-activity",
            serde_json::json!({ "worktreePath": wt, "kind": kind }),
        );
    }

    let result = (|| -> Result<serde_json::Value, String> {
        let worktree_path = params
            .get("worktree_path")
            .filter(|p| !p.is_empty())
            .ok_or("missing worktree_path")?;
        match path {
            "/browser/page_info" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                crate::browser::page_info(&wv)
            }
            "/browser/console" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let clear = params.get("clear").map(|c| c == "true").unwrap_or(false);
                crate::browser::console_logs(&wv, clear)
            }
            "/browser/screenshot" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let png_base64 = crate::browser::screenshot_png_base64(&wv)?;
                Ok(serde_json::json!({ "png_base64": png_base64 }))
            }
            "/browser/navigate" => {
                let url = params
                    .get("url")
                    .filter(|u| !u.is_empty())
                    .ok_or("missing url")?;
                crate::browser::navigate_worktree(app, worktree_path, url)
            }
            "/browser/click" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let selector = params
                    .get("selector")
                    .filter(|s| !s.is_empty())
                    .ok_or("missing selector")?;
                crate::browser::click_selector(app, &wv, selector)
            }
            "/browser/click_at" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let x = params
                    .get("x")
                    .and_then(|v| v.parse::<f64>().ok())
                    .ok_or("missing or invalid x")?;
                let y = params
                    .get("y")
                    .and_then(|v| v.parse::<f64>().ok())
                    .ok_or("missing or invalid y")?;
                crate::browser::click_at(app, &wv, x, y)
            }
            "/browser/scroll" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let dy = params
                    .get("dy")
                    .and_then(|v| v.parse::<f64>().ok())
                    .ok_or("missing or invalid dy")?;
                let dx = params
                    .get("dx")
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0);
                crate::browser::scroll(app, &wv, dx, dy)
            }
            "/browser/type" => {
                let wv = crate::browser::webview_for_worktree(app, worktree_path)?;
                let selector = params
                    .get("selector")
                    .filter(|s| !s.is_empty())
                    .ok_or("missing selector")?;
                // Empty text is legal — it clears the field.
                let text = params.get("text").map(|s| s.as_str()).unwrap_or("");
                crate::browser::type_into_selector(app, &wv, selector, text)
            }
            _ => Err(format!("unknown browser endpoint: {path}")),
        }
    })();
    match result {
        Ok(mut value) => {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("ok".to_string(), serde_json::Value::Bool(true));
            }
            value
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

/// Dispatch an /automations/* request (impala-mcp's automation tools). Same
/// contract as /browser/*: JSON object with an `ok` flag, errors in `error`.
/// Automations are keyed by the main repo path, so worktree-scoped calls
/// resolve through the .git gitdir link first.
fn handle_automation_request(
    app: &AppHandle,
    path: &str,
    params: &HashMap<String, String>,
) -> serde_json::Value {
    use tauri::Manager;

    let result = (|| -> Result<serde_json::Value, String> {
        let state = app.state::<crate::DbState>();
        let conn = state
            .0
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;

        let resolve_repo = || -> Result<String, String> {
            let worktree_path = params
                .get("worktree_path")
                .filter(|p| !p.is_empty())
                .ok_or("missing worktree_path")?;
            crate::agent_config::main_worktree_root(std::path::Path::new(worktree_path))
                .map(|p| p.to_string_lossy().to_string())
                .ok_or_else(|| "not inside a git repository".to_string())
        };
        let require = |key: &str| -> Result<&String, String> {
            params
                .get(key)
                .filter(|v| !v.is_empty())
                .ok_or(format!("missing {key}"))
        };

        match path {
            "/automations/list" => {
                let repo = resolve_repo()?;
                let automations = crate::automations::list_by_repo(&conn, &repo)?;
                let runs = crate::automations::list_runs_by_repo(&conn, &repo)?;
                Ok(serde_json::json!({ "automations": automations, "recent_runs": runs }))
            }
            "/automations/create" => {
                let repo = resolve_repo()?;
                // Default the agent to the calling worktree's own agent —
                // "check this again every morning" means "as me".
                let agent = match params.get("agent").filter(|a| !a.is_empty()) {
                    Some(a) => a.clone(),
                    None => params
                        .get("worktree_path")
                        .and_then(|wt| {
                            crate::settings::get_setting(&conn, "selectedAgent", wt)
                                .ok()
                                .flatten()
                        })
                        .unwrap_or_else(|| "codex".to_string()),
                };
                let created = crate::automations::create_automation_row(
                    &conn,
                    crate::automations::NewAutomation {
                        repo_path: repo,
                        name: require("name")?.clone(),
                        prompt: require("prompt")?.clone(),
                        agent,
                        schedule: require("schedule")?.clone(),
                    },
                    chrono::Utc::now().timestamp(),
                )?;
                let _ = app.emit("automations-changed", ());
                Ok(serde_json::json!({ "automation": created }))
            }
            "/automations/update" => {
                let id = require("id")?;
                let optional = |key: &str| params.get(key).filter(|v| !v.is_empty()).cloned();
                let updated = crate::automations::update_automation_row(
                    &conn,
                    id,
                    crate::automations::UpdateAutomation {
                        name: optional("name"),
                        prompt: optional("prompt"),
                        agent: optional("agent"),
                        schedule: optional("schedule"),
                        repo_path: None,
                    },
                    chrono::Utc::now().timestamp(),
                )?;
                let _ = app.emit("automations-changed", ());
                Ok(serde_json::json!({ "automation": updated }))
            }
            "/automations/run_now" => {
                let id = require("id")?;
                let automation = crate::automations::get_automation(&conn, id)?;
                crate::automations::dispatch(
                    app,
                    &conn,
                    &automation,
                    chrono::Utc::now().timestamp(),
                )?;
                Ok(serde_json::json!({ "started": automation.name }))
            }
            "/automations/set_enabled" => {
                let id = require("id")?;
                let enabled = require("enabled")? == "true";
                crate::automations::set_enabled_row(
                    &conn,
                    id,
                    enabled,
                    chrono::Utc::now().timestamp(),
                )?;
                let _ = app.emit("automations-changed", ());
                Ok(serde_json::json!({ "enabled": enabled }))
            }
            _ => Err(format!("unknown automations endpoint: {path}")),
        }
    })();
    match result {
        Ok(mut value) => {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("ok".to_string(), serde_json::Value::Bool(true));
            }
            value
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

fn handle_agent_request(
    app: &AppHandle,
    path: &str,
    params: &HashMap<String, String>,
    delegations: &AgentDelegations,
    pane_statuses: &AgentPaneStatuses,
) -> serde_json::Value {
    let result = (|| -> Result<serde_json::Value, String> {
        if path == "/agents/status" {
            let delegation_id = params
                .get("delegation_id")
                .filter(|value| !value.trim().is_empty())
                .ok_or("missing delegation_id")?;
            return serde_json::to_value(delegations.status(delegation_id, pane_statuses)?)
                .map_err(|error| format!("serialize delegation status: {error}"));
        }
        if path == "/agents/follow_up" {
            let delegation_id = params
                .get("delegation_id")
                .filter(|value| !value.trim().is_empty())
                .ok_or("missing delegation_id")?;
            let prompt = params
                .get("prompt")
                .filter(|value| !value.trim().is_empty())
                .ok_or("missing prompt")?;
            let target = delegations.begin_follow_up(delegation_id, pane_statuses)?;
            let result = (|| -> Result<serde_json::Value, String> {
                Ok(match target {
                    AgentFollowUpTarget::ManagedCodex {
                        thread_id,
                        app_server,
                    } => {
                        let started = crate::codex_app_server::start_turn(
                            &app_server,
                            &thread_id,
                            &format!("impala-agent-follow-up:{delegation_id}"),
                            prompt,
                        )?;
                        let turn_id = started
                            .get("turn")
                            .and_then(|turn| turn.get("id"))
                            .or_else(|| started.get("turnId"))
                            .and_then(serde_json::Value::as_str)
                            .ok_or_else(|| "Codex turn/start returned no turn id".to_string())?;
                        delegations.record_managed_turn(delegation_id, &thread_id, turn_id)?;
                        serde_json::json!({ "followed_up": true, "delegation_id": delegation_id, "transport": "app-server" })
                    }
                    AgentFollowUpTarget::Pty {
                        worktree_path,
                        pane_id,
                    } => {
                        write_agent_follow_up(app, &worktree_path, &pane_id, prompt)?;
                        serde_json::json!({ "followed_up": true, "delegation_id": delegation_id, "pane_id": pane_id, "transport": "pty" })
                    }
                })
            })();
            if let Err(error) = result {
                delegations.cancel_follow_up(delegation_id);
                return Err(error);
            }
            return Ok(result.expect("follow-up result was checked"));
        }
        if path == "/agents/steer" {
            let delegation_id = params
                .get("delegation_id")
                .filter(|value| !value.trim().is_empty())
                .ok_or("missing delegation_id")?;
            let prompt = params
                .get("prompt")
                .filter(|value| !value.trim().is_empty())
                .ok_or("missing prompt")?;
            let target = delegations.begin_steer(delegation_id, pane_statuses)?;
            crate::codex_app_server::steer_turn(
                &target.app_server,
                &target.thread_id,
                &target.turn_id,
                &format!("impala-agent-steer:{delegation_id}"),
                prompt,
            )?;
            return Ok(
                serde_json::json!({ "steered": true, "delegation_id": delegation_id, "transport": "app-server" }),
            );
        }
        if path != "/agents/open" {
            return Err(format!("unknown agents endpoint: {path}"));
        }
        let worktree_path = params
            .get("worktree_path")
            .filter(|value| !value.is_empty())
            .ok_or("missing worktree_path")?;
        let prompt = params
            .get("prompt")
            .filter(|value| !value.trim().is_empty())
            .ok_or("missing prompt")?;
        let agent = params.get("agent").filter(|value| !value.is_empty());
        if let Some(agent) = agent {
            if agent != "claude" && agent != "codex" {
                return Err("agent must be 'claude' or 'codex'".to_string());
            }
        }
        let name = params.get("name").filter(|value| !value.trim().is_empty());
        let delegation_id = params
            .get("delegation_id")
            .filter(|value| !value.trim().is_empty());
        let model = params.get("model").filter(|value| !value.trim().is_empty());
        let reasoning_effort = params
            .get("reasoning_effort")
            .filter(|value| !value.trim().is_empty());
        let service_tier = params
            .get("service_tier")
            .filter(|value| !value.trim().is_empty());
        if (model.is_some() || reasoning_effort.is_some() || service_tier.is_some())
            && agent.map(String::as_str) != Some("codex")
        {
            return Err("Codex launch options require agent=codex".to_string());
        }
        if agent.map(String::as_str) == Some("codex")
            && (model.is_some() || reasoning_effort.is_some() || service_tier.is_some())
        {
            let settings = agent_open_codex_settings(model, reasoning_effort, service_tier)?;
            app.state::<crate::codex_app_server::CodexAppServerState>()
                .native_settings_supported(&settings)
                .map_err(|error| format!("unsupported Codex launch settings: {error}"))?;
        }
        let source_thread_id = params
            .get("source_thread_id")
            .filter(|value| !value.trim().is_empty());
        let source_worktree_path = params
            .get("source_worktree_path")
            .filter(|value| !value.trim().is_empty());
        let placement = params
            .get("placement")
            .map(String::as_str)
            .unwrap_or("auto");
        if !matches!(placement, "auto" | "current" | "left" | "right" | "split") {
            return Err(
                "placement must be 'auto', 'current', 'left', 'right', or 'split'".to_string(),
            );
        }

        let callback_registered = match (delegation_id, source_thread_id, source_worktree_path) {
            (Some(delegation_id), Some(source_thread_id), Some(source_worktree_path)) => {
                let source = app
                    .state::<crate::codex_app_server::CodexAppServerState>()
                    .validate_persisted_managed_thread(source_thread_id, source_worktree_path);
                match source {
                    Ok(source_app_server) => delegations.open_from_managed_source(
                        delegation_id,
                        worktree_path,
                        name.map(String::as_str),
                        source_thread_id,
                        &source_app_server,
                    ),
                    Err(_) => {
                        delegations.open(
                            delegation_id,
                            worktree_path,
                            name.map(String::as_str),
                            None,
                            None,
                        );
                        false
                    }
                }
            }
            (Some(delegation_id), _, _) => {
                delegations.open(
                    delegation_id,
                    worktree_path,
                    name.map(String::as_str),
                    None,
                    None,
                );
                false
            }
            _ => false,
        };

        if let Err(error) = app.emit_to(
            "main",
            "agent-tab-request-open",
            serde_json::json!({
                "worktreePath": worktree_path,
                "prompt": prompt,
                "agent": agent,
                "name": name,
                "delegationId": delegation_id,
                "placement": placement,
                "model": model,
                "reasoningEffort": reasoning_effort,
                "serviceTier": service_tier,
            }),
        ) {
            if let Some(delegation_id) = delegation_id {
                delegations.fail(delegation_id, &error.to_string());
            }
            return Err(format!("failed to open agent tab: {error}"));
        }

        Ok(serde_json::json!({
            "opened": true,
            "delegation_id": delegation_id,
            "agent": agent.map(|value| value.as_str()).unwrap_or("configured"),
            "callback_registered": callback_registered,
        }))
    })();

    match result {
        Ok(mut value) => {
            value["ok"] = serde_json::Value::Bool(true);
            value
        }
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}

fn agent_open_codex_settings(
    model: Option<&String>,
    reasoning_effort: Option<&String>,
    service_tier: Option<&String>,
) -> Result<serde_json::Value, String> {
    let mut settings = serde_json::json!({});
    if let Some(model) = model {
        settings["model"] = serde_json::Value::String(model.clone());
    }
    if let Some(effort) = reasoning_effort {
        settings["effort"] = serde_json::Value::String(effort.clone());
    }
    if let Some(tier) = service_tier {
        settings["serviceTier"] = serde_json::Value::String(tier.clone());
    }
    crate::automations::validate_native_codex_settings(&settings)?;
    Ok(settings)
}

fn write_agent_follow_up(
    app: &AppHandle,
    worktree_path: &str,
    pane_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let daemon = app.state::<crate::daemon_client::DaemonState>();
    let response = tauri::async_runtime::block_on(async {
        daemon
            .client()
            .await?
            .request(agent_follow_up_write_request(
                worktree_path,
                pane_id,
                prompt,
            ))
            .await
    })?;
    match response {
        DaemonResponse::Wrote => Ok(()),
        DaemonResponse::Error { message } => Err(message),
        _ => Err("unexpected daemon response while following up agent tab".to_string()),
    }
}

fn agent_follow_up_write_request(worktree_path: &str, pane_id: &str, prompt: &str) -> Request {
    Request::Write {
        session_id: format!("pty-{pane_id}-{worktree_path}"),
        data_b64: STANDARD.encode(format!("{prompt}\r").as_bytes()),
    }
}

/// Start the hook HTTP server on a random port. Returns the port number.
/// The `statuses` map is updated with every event so the frontend can query
/// last-known agent status after a hard reload.
pub fn start(
    app_handle: AppHandle,
    statuses: Arc<AgentStatuses>,
    pane_statuses: Arc<AgentPaneStatuses>,
    delegations: Arc<AgentDelegations>,
    pane_registry: Arc<PaneRegistry>,
    snapshots: Arc<LastTurnSnapshots>,
    interrupted_turns: Arc<InterruptedAgentTurns>,
    subagents: Arc<crate::subagents::SubagentRegistry>,
) -> u16 {
    let server = Arc::new(Server::http("127.0.0.1:0").expect("Failed to start hook server"));
    let port = server.server_addr().to_ip().unwrap().port();

    if let Some(home) = dirs::home_dir() {
        let _ = publish_hook_port(&home, port);
    }

    std::thread::spawn(move || {
        let mut automation_completion = AutomationCompletionTracker::load_persisted();
        for mut request in server.incoming_requests() {
            let url = request.url().to_string();
            let path = url.splitn(2, '?').next().unwrap_or("").to_string();

            let params: HashMap<String, String> = url
                .splitn(2, '?')
                .nth(1)
                .unwrap_or("")
                .split('&')
                .filter_map(|pair| {
                    let mut parts = pair.splitn(2, '=');
                    let key = parts.next()?;
                    let value = parts.next().unwrap_or("");
                    // Clients (curl -G --data-urlencode, reqwest's
                    // parse_with_params) send form encoding: space arrives
                    // as '+', a literal '+' as %2B — undo the '+' first.
                    let value = value.replace('+', " ");
                    Some((
                        key.to_string(),
                        urlencoding::decode(&value).unwrap_or_default().into_owned(),
                    ))
                })
                .collect();

            if path == "/codex/launch" {
                let worktree_path = params
                    .get("worktree_path")
                    .map(String::as_str)
                    .unwrap_or("");
                let pane_id = params.get("pane_id").map(String::as_str).unwrap_or("");
                let session_id = params.get("session_id").map(String::as_str);
                let accepted =
                    pane_registry.record_codex_launch(worktree_path, pane_id, session_id);
                if let Some(session_id) =
                    session_id.filter(|session_id| accepted && !session_id.is_empty())
                {
                    subagents.resume_codex_session(worktree_path, pane_id, session_id);
                    let _ = app_handle.emit(
                        "subagents-changed",
                        serde_json::json!({
                            "worktreePath": worktree_path,
                            "paneId": pane_id,
                        }),
                    );
                }
                let response = Response::from_string(if accepted {
                    r#"{"ok":true}"#
                } else {
                    r#"{"ok":false}"#
                })
                .with_status_code(if accepted { 200 } else { 409 })
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .expect("static header"),
                );
                let _ = request.respond(response);
                continue;
            }

            // Browser agent-hook endpoints (impala-mcp). Screenshots/eval can
            // take seconds — handle on their own thread so /hook (agent
            // status, latency-critical) never queues behind them.
            if path.starts_with("/browser/")
                || path.starts_with("/automations/")
                || path.starts_with("/agents/")
            {
                let app = app_handle.clone();
                let pane_statuses = pane_statuses.clone();
                let delegations = delegations.clone();
                std::thread::spawn(move || {
                    let body = if path.starts_with("/browser/") {
                        handle_browser_request(&app, &path, &params)
                    } else if path.starts_with("/agents/") {
                        handle_agent_request(&app, &path, &params, &delegations, &pane_statuses)
                    } else {
                        handle_automation_request(&app, &path, &params)
                    };
                    let response = Response::from_string(body.to_string()).with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .expect("static header"),
                    );
                    let _ = request.respond(response);
                });
                continue;
            }

            let event_type = params.get("event_type").map(|s| s.as_str()).unwrap_or("");
            let mut hook_payload = String::new();
            let _ = request.as_reader().read_to_string(&mut hook_payload);
            let hook_identity = serde_json::from_str::<serde_json::Value>(&hook_payload).ok();
            let ((worktree_path, pane_id), provider) = hook_target_for_identity(
                &delegations,
                &pane_registry,
                &params,
                hook_identity.as_ref(),
            );

            // Persist the provider session and the first turn identity on the
            // automation run. The completion reconciler can then recover an
            // exact Codex task_complete even when this hook delivery is lost.
            if !worktree_path.is_empty() && pane_id == "tab-agent" {
                use tauri::Manager;
                let session_id = hook_identity
                    .as_ref()
                    .and_then(|value| value["session_id"].as_str());
                let turn_id = hook_identity
                    .as_ref()
                    .and_then(|value| value["turn_id"].as_str());
                let state = app_handle.state::<crate::DbState>();
                let connection = state.0.lock();
                if let Ok(conn) = connection {
                    let _ = crate::automations::record_run_agent_lifecycle(
                        &conn,
                        &worktree_path,
                        &provider,
                        session_id,
                        turn_id,
                    );
                }
            }

            if !pane_id.is_empty() {
                subagents.ingest_hook(
                    &app_handle,
                    &worktree_path,
                    &pane_id,
                    &provider,
                    event_type,
                    &hook_payload,
                );
            }

            let suppress_interrupted_event =
                interrupted_turns.suppresses(&worktree_path, &pane_id, event_type);
            let automation_should_complete = if worktree_path.is_empty()
                || pane_id != "tab-agent"
                || suppress_interrupted_event
            {
                false
            } else {
                automation_completion.observe(&worktree_path, &pane_id, event_type, &hook_payload)
            };
            let status = if suppress_interrupted_event || pane_id.is_empty() {
                ""
            } else {
                pane_status_for_hook_event(
                    event_type,
                    automation_should_complete,
                    automation_completion.has_active_tools(&worktree_path, &pane_id),
                    pane_statuses.contains(&worktree_path, &pane_id),
                )
            };

            // A stopped lead turn completes its launched automation only
            // after any yielded background tools have also finished. Emitted
            // before agent-status so the frontend can specialize the
            // completion notification.
            if automation_should_complete && !worktree_path.is_empty() {
                use tauri::Manager;
                let state = app_handle.state::<crate::DbState>();
                let completed_name = state
                    .0
                    .lock()
                    .ok()
                    .and_then(|conn| {
                        crate::automations::complete_run_for_worktree(&conn, &worktree_path).ok()
                    })
                    .flatten();
                if let Some(automation_name) = completed_name {
                    crate::automations::stop_completed_global_run_if_unclaimed(
                        &app_handle,
                        &worktree_path,
                    );
                    let _ = app_handle.emit(
                        "automation-run-completed",
                        serde_json::json!({
                            "worktree_path": worktree_path,
                            "automation_name": automation_name,
                        }),
                    );
                    let _ = app_handle.emit("automation-runs-changed", ());
                }
            }

            if !status.is_empty() && !worktree_path.is_empty() {
                let aggregate_status =
                    delegations.observe_hook(&worktree_path, &pane_id, &pane_statuses, status);
                if status == "idle" {
                    match delegations.finish(&worktree_path, &pane_id) {
                        Ok(Some(summary)) if summary.files > 0 => {
                            let _ = app_handle.emit("agent-run-changes-completed", summary);
                        }
                        Ok(_) => {}
                        Err(error) => eprintln!(
                            "[impala] delegated agent completion snapshot failed for {}: {}",
                            worktree_path, error
                        ),
                    }
                    if let Some(notification) =
                        delegations.claim_completion_for_pane(&worktree_path, &pane_id)
                    {
                        dispatch_completion(delegations.clone(), notification);
                    }
                }
                publish_agent_pane_event(&app_handle, &worktree_path, &pane_id, status);
                publish_agent_status(&app_handle, &statuses, &worktree_path, &aggregate_status);
            }

            // Snapshot the worktree at the start of every turn so the "Last
            // turn" diff view has a baseline. Done synchronously so the
            // snapshot is captured before the agent starts modifying files.
            // A session outlives its worktree (deleted while its agent kept
            // running), and every prompt it submits would otherwise log a
            // git failure for a directory that is gone. Nothing to baseline.
            if event_type == "UserPromptSubmit"
                && !worktree_path.is_empty()
                && std::path::Path::new(&worktree_path).is_dir()
            {
                match crate::git::snapshot_worktree(&worktree_path) {
                    Ok(tree) => {
                        if let Ok(mut map) = snapshots.0.lock() {
                            map.insert(worktree_path.clone(), tree);
                        }
                        let _ = app_handle.emit(
                            "last-turn-snapshot-changed",
                            LastTurnSnapshotEvent {
                                worktree_path: worktree_path.clone(),
                            },
                        );
                    }
                    Err(e) => {
                        eprintln!(
                            "[impala] last-turn snapshot failed for {}: {}",
                            worktree_path, e
                        );
                    }
                }
            }

            let _ = request.respond(Response::from_string("ok"));
        }
    });

    port
}

/// Publish the hook server used as a fallback by sessions that outlive their
/// launching Impala instance. A short-lived second instance must not replace a
/// healthy primary's discovery port.
fn publish_hook_port(home: &Path, port: u16) -> std::io::Result<()> {
    let dir = home.join(".impala");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("hook-port");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if let Ok(existing) = existing.trim().parse::<u16>() {
            let address = std::net::SocketAddr::from(([127, 0, 0, 1], existing));
            if std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(100))
                .is_ok()
            {
                return Ok(());
            }
        }
    }
    std::fs::write(path, port.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        agent_follow_up_write_request, agent_open_codex_settings, hook_command,
        hook_target_for_identity, pane_status_for_hook_event, publish_hook_port,
        wake_target_is_gone, AgentDelegations, AgentFollowUpTarget, AgentPaneStatuses,
        AgentSteerTarget, AutomationCompletionTracker, InterruptedAgentTurns, PaneRegistry,
        PersistedCodexPane, IMPALA_BROWSER_SKILL,
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use impala_daemon_shared::wire::Request;
    use std::collections::HashMap;
    use std::fs;
    use std::io::Write;
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Barrier};

    #[test]
    fn agent_open_uses_the_shared_catalog_for_future_codex_identifiers() {
        let model = "future-model".to_string();
        let effort = "deep".to_string();
        let tier = "priority".to_string();
        let settings = agent_open_codex_settings(Some(&model), Some(&effort), Some(&tier)).unwrap();
        let catalog = [crate::codex_app_server::ModelCatalogEntry {
            id: model,
            is_default: true,
            efforts: vec![effort],
            tiers: vec![tier],
            modalities: vec!["text".to_string()],
        }];
        assert!(
            crate::codex_app_server::validate_native_settings_catalog(&settings, &catalog).is_ok()
        );
    }

    #[test]
    fn hook_port_discovery_preserves_a_reachable_primary() {
        let temp = tempfile::tempdir().unwrap();
        let primary = TcpListener::bind("127.0.0.1:0").unwrap();
        let primary_port = primary.local_addr().unwrap().port();
        let secondary = TcpListener::bind("127.0.0.1:0").unwrap();
        let secondary_port = secondary.local_addr().unwrap().port();
        let impala_dir = temp.path().join(".impala");
        fs::create_dir_all(&impala_dir).unwrap();
        fs::write(impala_dir.join("hook-port"), primary_port.to_string()).unwrap();

        publish_hook_port(temp.path(), secondary_port).unwrap();

        assert_eq!(
            fs::read_to_string(impala_dir.join("hook-port")).unwrap(),
            primary_port.to_string()
        );
    }

    #[test]
    fn hook_port_discovery_replaces_a_stale_port() {
        let temp = tempfile::tempdir().unwrap();
        let stale = TcpListener::bind("127.0.0.1:0").unwrap();
        let stale_port = stale.local_addr().unwrap().port();
        drop(stale);
        let impala_dir = temp.path().join(".impala");
        fs::create_dir_all(&impala_dir).unwrap();
        fs::write(impala_dir.join("hook-port"), stale_port.to_string()).unwrap();

        publish_hook_port(temp.path(), 60158).unwrap();

        assert_eq!(
            fs::read_to_string(impala_dir.join("hook-port")).unwrap(),
            "60158"
        );
    }

    #[test]
    fn delegation_status_follows_the_registered_pane() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();

        delegations.open("delegation-1", "/worktree", Some("SQS-24"), None, None);
        assert_eq!(
            delegations.test_status("delegation-1", &panes).unwrap().0,
            "pending"
        );
        assert!(delegations.register("delegation-1", "pane-1"));

        delegations.observe_hook("/worktree", "pane-1", &panes, "working");
        assert_eq!(
            delegations.test_status("delegation-1", &panes).unwrap().0,
            "running"
        );

        panes.observe("/worktree", "pane-1", "permission");
        assert_eq!(
            delegations.test_status("delegation-1", &panes).unwrap().0,
            "waiting"
        );

        panes.observe("/worktree", "pane-1", "idle");
        assert_eq!(
            delegations.test_status("delegation-1", &panes).unwrap().0,
            "idle"
        );

        assert!(delegations.fail("delegation-1", "PTY spawn failed"));
        let status = delegations.test_status("delegation-1", &panes).unwrap();
        assert_eq!(status.0, "failed");
        assert_eq!(status.1.as_deref(), Some("PTY spawn failed"));
    }

    #[test]
    fn delegation_status_snapshot_keeps_pty_fallback_read_only() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        delegations.open(
            "delegation-1",
            "/worktree",
            Some("Claude review"),
            Some("thread-parent"),
            Some("unix:///tmp/source.sock"),
        );
        assert!(delegations.register("delegation-1", "pane-1"));
        delegations.observe_hook("/worktree", "pane-1", &panes, "working");

        let status = delegations.status("delegation-1", &panes).unwrap();
        assert_eq!(status.status, "running");
        assert_eq!(status.transport, "pty");
        assert!(status.callback_registered);
        assert!(status.app_server_progress.is_none());
        assert!(status.progress_error.is_none());
        assert!(!status.can_steer);
        assert!(!status.can_follow_up);
        assert_eq!(
            delegations.status("missing", &panes).unwrap_err(),
            "delegation not found: missing"
        );
    }

    #[test]
    fn delegation_completion_claims_one_codex_callback_until_delivery_finishes() {
        let delegations = AgentDelegations::default();
        delegations.open(
            "delegation-1",
            "/worktree",
            Some("Luna implementation"),
            Some("thread-1"),
            Some("unix:///tmp/impala.sock"),
        );
        assert!(delegations.fail("delegation-1", "worker crashed"));

        let first = delegations
            .claim_completion_for_delegation("delegation-1")
            .unwrap();
        assert_eq!(first.thread_id, "thread-1");
        assert!(first.prompt.contains("Luna implementation"));
        assert!(first.prompt.contains("failed: worker crashed"));
        assert!(delegations
            .claim_completion_for_delegation("delegation-1")
            .is_none());

        delegations.finish_completion_notification("delegation-1", false);
        let recovered = delegations.claim_pending_completions(&AgentPaneStatuses::default());
        assert_eq!(recovered.len(), 1);
        delegations.finish_completion_notification("delegation-1", true);
        assert!(delegations
            .claim_completion_for_delegation("delegation-1")
            .is_none());
    }

    #[test]
    fn managed_completion_reconciles_when_the_pane_hook_stays_working() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        let remote = format!(
            "unix://{}",
            crate::agent_config::codex_home_path()
                .unwrap()
                .join("app-server-control/app-server-control.sock")
                .display()
        );
        delegations.open(
            "delegation-1",
            "/worktree",
            Some("Ticket 01"),
            Some("parent-thread"),
            Some(&remote),
        );
        assert!(delegations.register_managed_codex_target(
            "delegation-1",
            "/worktree",
            "pane-1",
            "worker-thread",
            &remote,
        ));
        delegations
            .record_managed_turn("delegation-1", "worker-thread", "worker-turn")
            .unwrap();
        delegations.observe_hook("/worktree", "pane-1", &panes, "working");

        let notifications =
            delegations.claim_managed_completions_with(&panes, |app_server, thread_id| {
                assert_eq!(app_server, remote);
                assert_eq!(thread_id, "worker-thread");
                Ok(crate::codex_app_server::ManagedThreadProgress {
                    thread_status: "idle".to_string(),
                    updated_at: Some(123),
                    turn_id: Some("worker-turn".to_string()),
                    turn_status: Some("completed".to_string()),
                    turn_error: None,
                    latest_activity: None,
                })
            });

        assert_eq!(notifications.len(), 1);
        assert!(notifications[0].prompt.contains("Ticket 01"));
        assert_eq!(panes.status("/worktree", "pane-1"), None);
        assert!(delegations
            .claim_managed_completions_with(&panes, |_, _| unreachable!())
            .is_empty());
    }

    #[test]
    fn managed_completion_requires_the_exact_registered_terminal_turn() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        let remote = format!(
            "unix://{}",
            crate::agent_config::codex_home_path()
                .unwrap()
                .join("app-server-control/app-server-control.sock")
                .display()
        );
        delegations.open(
            "delegation-1",
            "/worktree",
            None,
            Some("parent-thread"),
            Some(&remote),
        );
        assert!(delegations.register_managed_codex_target(
            "delegation-1",
            "/worktree",
            "pane-1",
            "worker-thread",
            &remote,
        ));
        delegations
            .record_managed_turn("delegation-1", "worker-thread", "expected-turn")
            .unwrap();
        delegations.observe_hook("/worktree", "pane-1", &panes, "working");

        let notifications = delegations.claim_managed_completions_with(&panes, |_, _| {
            Ok(crate::codex_app_server::ManagedThreadProgress {
                thread_status: "idle".to_string(),
                updated_at: Some(123),
                turn_id: Some("later-turn".to_string()),
                turn_status: Some("completed".to_string()),
                turn_error: None,
                latest_activity: None,
            })
        });

        assert!(notifications.is_empty());
        assert_eq!(
            panes.status("/worktree", "pane-1").as_deref(),
            Some("working")
        );
    }

    #[test]
    fn delegation_without_an_impala_codex_thread_has_no_callback() {
        let delegations = AgentDelegations::default();
        delegations.open("delegation-1", "/worktree", None, None, None);
        assert!(delegations.fail("delegation-1", "worker crashed"));
        assert!(delegations
            .claim_completion_for_delegation("delegation-1")
            .is_none());
    }

    #[test]
    fn managed_source_registers_the_requested_callback() {
        let delegations = AgentDelegations::default();
        let remote = format!(
            "unix://{}",
            crate::agent_config::codex_home_path()
                .unwrap()
                .join("app-server-control/app-server-control.sock")
                .display()
        );

        assert!(delegations.open_from_managed_source(
            "delegation-2",
            "/target-worktree",
            None,
            "parent-thread-2",
            &remote,
        ));
        let entry = delegations.entries.lock().unwrap()["delegation-2"].clone();
        assert_eq!(entry.worktree_path, "/target-worktree");
        assert_eq!(entry.source_thread_id.as_deref(), Some("parent-thread-2"));
        assert_eq!(entry.source_app_server.as_deref(), Some(remote.as_str()));
        assert!(delegations.fail("delegation-2", "worker finished"));
        let notification = delegations
            .claim_completion_for_delegation("delegation-2")
            .unwrap();
        assert_eq!(notification.thread_id, "parent-thread-2");
        assert_eq!(notification.app_server, remote);
    }

    #[test]
    fn managed_targets_map_hook_bodies_by_exact_thread() {
        let delegations = AgentDelegations::default();
        let remote = format!(
            "unix://{}",
            crate::agent_config::codex_home_path()
                .unwrap()
                .join("app-server-control/app-server-control.sock")
                .display()
        );
        for (delegation_id, pane_id, thread_id) in [
            ("delegation-1", "pane-1", "thread-1"),
            ("delegation-2", "pane-2", "thread-2"),
        ] {
            delegations.open(
                delegation_id,
                "/worktree",
                None,
                Some("parent"),
                Some(&remote),
            );
            assert!(delegations.register_managed_codex_target(
                delegation_id,
                "/worktree",
                pane_id,
                thread_id,
                &remote,
            ));
        }
        assert_eq!(
            delegations.managed_codex_target_for_hook("thread-2", "/worktree"),
            Some(("/worktree".to_string(), "pane-2".to_string()))
        );
        assert_eq!(
            delegations.managed_codex_target_for_hook("thread-2", "/other"),
            None
        );
        assert_eq!(
            delegations.managed_codex_target_for_hook("unknown", "/worktree"),
            None
        );
        assert!(!delegations.register_managed_codex_target(
            "delegation-1",
            "/worktree",
            "pane-1",
            "replacement-thread",
            &remote,
        ));
    }

    #[test]
    fn unmatched_codex_hook_keeps_its_legacy_provider_and_pane() {
        let delegations = AgentDelegations::default();
        let remote = format!(
            "unix://{}",
            crate::agent_config::codex_home_path()
                .unwrap()
                .join("app-server-control/app-server-control.sock")
                .display()
        );
        delegations.open("managed", "/worktree", None, None, None);
        assert!(delegations.register_managed_codex_target(
            "managed",
            "/worktree",
            "managed-pane",
            "managed-thread",
            &remote,
        ));
        let params = HashMap::from([
            ("worktree_path".to_string(), "/worktree".to_string()),
            ("pane_id".to_string(), "alternate-pane".to_string()),
            ("agent_provider".to_string(), "codex".to_string()),
        ]);
        assert_eq!(
            hook_target_for_identity(
                &delegations,
                &PaneRegistry::default(),
                &params,
                Some(&serde_json::json!({ "session_id": "alternate-thread", "cwd": "/worktree" })),
            ),
            (
                ("/worktree".to_string(), "alternate-pane".to_string()),
                "codex".to_string(),
            )
        );
    }

    #[test]
    fn unattributed_codex_hook_recovers_pane_from_spawn_registry() {
        let delegations = AgentDelegations::default();
        let registry = PaneRegistry::default();
        let empty_params = HashMap::new();
        let identity = serde_json::json!({ "session_id": "thread-1", "cwd": "/worktree" });

        // No registration → stays unattributed.
        assert_eq!(
            hook_target_for_identity(&delegations, &registry, &empty_params, Some(&identity)),
            ((String::new(), String::new()), String::new())
        );

        // A Claude pane in the worktree never matches.
        registry.record(
            "pty-tab-agent-/worktree",
            "/worktree",
            "tab-agent",
            "claude",
        );
        assert_eq!(
            hook_target_for_identity(&delegations, &registry, &empty_params, Some(&identity)),
            ((String::new(), String::new()), String::new())
        );

        // A respawn with provider codex overwrites and matches.
        registry.record("pty-tab-agent-/worktree", "/worktree", "tab-agent", "codex");
        assert_eq!(
            hook_target_for_identity(&delegations, &registry, &empty_params, Some(&identity)),
            (
                ("/worktree".to_string(), "tab-agent".to_string()),
                "codex".to_string()
            )
        );

        // Several codex panes: the agent pane wins.
        registry.record(
            "pty-terminal-1-/worktree",
            "/worktree",
            "terminal-1",
            "codex",
        );
        assert_eq!(
            hook_target_for_identity(&delegations, &registry, &empty_params, Some(&identity)),
            (
                ("/worktree".to_string(), "tab-agent".to_string()),
                "codex".to_string()
            )
        );

        // The managed app-server drops the terminal environment, so the
        // wrapper announces which pane is about to create the next thread.
        assert!(registry.record_codex_launch("/worktree", "terminal-1", None));
        assert!(!registry.record_codex_launch("/worktree", "terminal-2", None));
        let terminal_identity =
            serde_json::json!({ "session_id": "thread-terminal", "cwd": "/worktree" });
        assert_eq!(
            hook_target_for_identity(
                &delegations,
                &registry,
                &empty_params,
                Some(&terminal_identity),
            ),
            (
                ("/worktree".to_string(), "terminal-1".to_string()),
                "codex".to_string()
            )
        );
        assert!(registry.record_codex_launch("/worktree", "terminal-2", None));
        let second_terminal_identity =
            serde_json::json!({ "session_id": "thread-terminal-2", "cwd": "/worktree" });
        assert_eq!(
            hook_target_for_identity(
                &delegations,
                &registry,
                &empty_params,
                Some(&second_terminal_identity),
            ),
            (
                ("/worktree".to_string(), "terminal-2".to_string()),
                "codex".to_string()
            )
        );
        // Later hooks for that thread keep their pane without another launch.
        assert_eq!(
            hook_target_for_identity(
                &delegations,
                &registry,
                &empty_params,
                Some(&terminal_identity),
            ),
            (
                ("/worktree".to_string(), "terminal-1".to_string()),
                "codex".to_string()
            )
        );

        // Resuming that durable thread in another pane must move future
        // hooks to the pane that issued the resume.
        assert!(registry.record_codex_launch("/worktree", "terminal-2", Some("thread-terminal")));
        assert_eq!(
            hook_target_for_identity(
                &delegations,
                &registry,
                &empty_params,
                Some(&terminal_identity),
            ),
            (
                ("/worktree".to_string(), "terminal-2".to_string()),
                "codex".to_string()
            )
        );

        // Ambiguous without an agent pane: bail instead of guessing.
        let other = serde_json::json!({ "session_id": "thread-2", "cwd": "/other" });
        registry.record("pty-terminal-1-/other", "/other", "terminal-1", "codex");
        registry.record("pty-terminal-2-/other", "/other", "terminal-2", "codex");
        assert_eq!(
            hook_target_for_identity(&delegations, &registry, &empty_params, Some(&other)),
            ((String::new(), String::new()), String::new())
        );

        // Explicit env-derived params always win over the registry.
        let params = HashMap::from([
            ("worktree_path".to_string(), "/worktree".to_string()),
            ("pane_id".to_string(), "pane-x".to_string()),
            ("agent_provider".to_string(), "claude".to_string()),
        ]);
        assert_eq!(
            hook_target_for_identity(&delegations, &registry, &params, Some(&identity)),
            (
                ("/worktree".to_string(), "pane-x".to_string()),
                "claude".to_string()
            )
        );
    }

    #[test]
    fn reattaching_a_persisted_codex_pty_does_not_downgrade_its_provider() {
        let worktree = std::env::temp_dir();
        let worktree = worktree.to_str().unwrap();
        let pty_session_id = format!("pty-tab-agent-{worktree}");
        let registry = PaneRegistry::from_persisted(vec![PersistedCodexPane {
            worktree_path: worktree.to_string(),
            pane_id: "tab-agent".to_string(),
            provider: "codex".to_string(),
        }]);

        registry.record_spawn(&pty_session_id, worktree, "tab-agent", "claude", true);

        assert_eq!(
            registry.codex_pane_for_hook(worktree, Some("resumed-thread")),
            Some((worktree.to_string(), "tab-agent".to_string()))
        );
    }

    #[test]
    fn closing_a_pending_delegated_pane_reports_failure() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        delegations.open("delegation-1", "/worktree", None, None, None);
        assert!(delegations.register("delegation-1", "pane-1"));

        assert!(delegations.fail_nonterminal_pane(
            "/worktree",
            "pane-1",
            &panes,
            "Agent tab closed before completion",
        ));

        let result = delegations.test_status("delegation-1", &panes).unwrap();
        assert_eq!(result.0, "failed");
        assert_eq!(
            result.1.as_deref(),
            Some("Agent tab closed before completion")
        );
    }

    #[test]
    fn closing_a_worktree_claims_its_failed_completion_callback() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        delegations.open(
            "delegation-1",
            "/worktree",
            None,
            Some("thread-1"),
            Some("unix:///tmp/impala.sock"),
        );
        assert!(delegations.register("delegation-1", "pane-1"));
        delegations.observe_hook("/worktree", "pane-1", &panes, "working");

        assert_eq!(
            delegations.fail_nonterminal_worktree(
                "/worktree",
                &panes,
                "Worktree closed before agent completion",
            ),
            1
        );
        let notifications = delegations.claim_pending_completions(&panes);
        assert_eq!(notifications.len(), 1);
        assert!(notifications[0]
            .prompt
            .contains("failed: Worktree closed before agent completion"));
    }

    #[test]
    fn delegation_follow_up_targets_only_an_idle_registered_pane() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();

        delegations.open("delegation-1", "/worktree", None, None, None);
        assert_eq!(
            delegations.begin_follow_up("delegation-1", &panes),
            Err("delegation is pending; follow-ups require an idle tab".to_string())
        );

        assert!(delegations.register("delegation-1", "pane-1"));
        delegations.observe_hook("/worktree", "pane-1", &panes, "working");
        assert_eq!(
            delegations.begin_follow_up("delegation-1", &panes),
            Err("delegation is running; follow-ups require an idle tab".to_string())
        );

        panes.observe("/worktree", "pane-1", "permission");
        assert_eq!(
            delegations.begin_follow_up("delegation-1", &panes),
            Err("delegation is waiting; follow-ups require an idle tab".to_string())
        );

        panes.observe("/worktree", "pane-1", "idle");
        assert_eq!(
            delegations.begin_follow_up("delegation-1", &panes),
            Ok(AgentFollowUpTarget::Pty {
                worktree_path: "/worktree".to_string(),
                pane_id: "pane-1".to_string(),
            })
        );
        assert_eq!(
            delegations.test_status("delegation-1", &panes).unwrap().0,
            "pending"
        );

        delegations.observe_hook("/worktree", "pane-1", &panes, "working");
        assert_eq!(
            delegations.test_status("delegation-1", &panes).unwrap().0,
            "running"
        );
        panes.observe("/worktree", "pane-1", "idle");
        assert_eq!(
            delegations.test_status("delegation-1", &panes).unwrap().0,
            "idle"
        );

        assert!(delegations.begin_follow_up("delegation-1", &panes).is_ok());
        delegations.cancel_follow_up("delegation-1");
        assert_eq!(
            delegations.test_status("delegation-1", &panes).unwrap().0,
            "idle"
        );

        delegations.open("failed", "/worktree", None, None, None);
        assert!(delegations.fail("failed", "PTY failed"));
        assert_eq!(
            delegations.begin_follow_up("failed", &panes),
            Err("delegation is failed; follow-ups require an idle tab".to_string())
        );
    }

    #[test]
    fn managed_codex_target_is_captured_persisted_and_used_for_follow_up() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        let remote = format!(
            "unix://{}",
            crate::agent_config::codex_home_path()
                .unwrap()
                .join("app-server-control/app-server-control.sock")
                .display()
        );
        delegations.open("delegation-1", "/worktree", None, None, None);
        assert!(delegations.register("delegation-1", "pane-1"));
        assert!(delegations.register_managed_codex_target(
            "delegation-1",
            "/worktree",
            "pane-1",
            "thread-1",
            &remote,
        ));
        delegations
            .record_managed_turn("delegation-1", "thread-1", "turn-1")
            .unwrap();
        let persisted = delegations.entries.lock().unwrap()["delegation-1"].clone();
        let restored: super::AgentDelegation =
            serde_json::from_value(serde_json::to_value(&persisted).unwrap()).unwrap();
        assert_eq!(restored.target_thread_id.as_deref(), Some("thread-1"));
        assert_eq!(restored.target_app_server.as_deref(), Some(remote.as_str()));
        assert_eq!(restored.target_turn_id.as_deref(), Some("turn-1"));
        delegations.observe_hook("/worktree", "pane-1", &panes, "idle");
        assert_eq!(
            delegations.begin_follow_up("delegation-1", &panes),
            Ok(AgentFollowUpTarget::ManagedCodex {
                thread_id: "thread-1".to_string(),
                app_server: remote,
            })
        );
    }

    #[test]
    fn steering_requires_a_running_managed_codex_turn() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        let remote = format!(
            "unix://{}",
            crate::agent_config::codex_home_path()
                .unwrap()
                .join("app-server-control/app-server-control.sock")
                .display()
        );
        delegations.open("delegation-1", "/worktree", None, None, None);
        assert!(delegations.register("delegation-1", "pane-1"));
        assert_eq!(
            delegations.begin_steer("delegation-1", &panes),
            Err("delegation is pending; steering requires a running managed Codex tab".to_string())
        );
        delegations.observe_hook("/worktree", "pane-1", &panes, "working");
        assert_eq!(
            delegations.begin_steer("delegation-1", &panes),
            Err("delegation has no managed Codex target thread".to_string())
        );
        assert!(delegations.register_managed_codex_target(
            "delegation-1",
            "/worktree",
            "pane-1",
            "thread-1",
            &remote,
        ));
        delegations
            .record_managed_turn("delegation-1", "thread-1", "turn-1")
            .unwrap();
        assert_eq!(
            delegations.begin_steer("delegation-1", &panes),
            Ok(AgentSteerTarget {
                thread_id: "thread-1".to_string(),
                app_server: remote,
                turn_id: "turn-1".to_string(),
            })
        );
        panes.observe("/worktree", "pane-1", "permission");
        assert_eq!(
            delegations.begin_steer("delegation-1", &panes),
            Err("delegation is waiting; steering requires a running managed Codex tab".to_string())
        );
    }

    #[test]
    fn managed_follow_up_replaces_the_turn_used_for_subsequent_steering() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        let remote = format!(
            "unix://{}",
            crate::agent_config::codex_home_path()
                .unwrap()
                .join("app-server-control/app-server-control.sock")
                .display()
        );
        delegations.open("delegation-1", "/worktree", None, None, None);
        assert!(delegations.register("delegation-1", "pane-1"));
        assert!(delegations.register_managed_codex_target(
            "delegation-1",
            "/worktree",
            "pane-1",
            "thread-1",
            &remote,
        ));
        delegations
            .record_managed_turn("delegation-1", "thread-1", "turn-old")
            .unwrap();
        delegations.observe_hook("/worktree", "pane-1", &panes, "idle");

        assert!(matches!(
            delegations.begin_follow_up("delegation-1", &panes),
            Ok(AgentFollowUpTarget::ManagedCodex { .. })
        ));
        delegations
            .record_managed_turn("delegation-1", "thread-1", "turn-new")
            .unwrap();
        delegations.observe_hook("/worktree", "pane-1", &panes, "working");

        assert_eq!(
            delegations
                .begin_steer("delegation-1", &panes)
                .unwrap()
                .turn_id,
            "turn-new"
        );
    }

    #[test]
    fn inconsistent_managed_target_never_falls_back_to_the_pty() {
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        delegations.open("delegation-1", "/worktree", None, None, None);
        assert!(delegations.register("delegation-1", "pane-1"));
        delegations.observe_hook("/worktree", "pane-1", &panes, "idle");
        delegations
            .entries
            .lock()
            .unwrap()
            .get_mut("delegation-1")
            .unwrap()
            .target_thread_id = Some("thread-1".to_string());
        assert_eq!(
            delegations.begin_follow_up("delegation-1", &panes),
            Err("delegation has an inconsistent managed Codex target identity".to_string())
        );
    }

    #[test]
    fn agent_follow_up_uses_the_existing_pane_pty_and_submits_the_prompt() {
        match agent_follow_up_write_request("/worktree", "pane-1", "Fix the review") {
            Request::Write {
                session_id,
                data_b64,
            } => {
                assert_eq!(session_id, "pty-pane-1-/worktree");
                assert_eq!(STANDARD.decode(data_b64).unwrap(), b"Fix the review\r");
            }
            request => panic!("unexpected request: {request:?}"),
        }
    }

    #[test]
    fn concurrent_follow_ups_claim_an_idle_delegation_once() {
        let delegations = Arc::new(AgentDelegations::default());
        let panes = Arc::new(AgentPaneStatuses::default());
        delegations.open("delegation-1", "/worktree", None, None, None);
        assert!(delegations.register("delegation-1", "pane-1"));
        delegations.observe_hook("/worktree", "pane-1", &panes, "idle");

        let barrier = Arc::new(Barrier::new(3));
        let claims: Vec<_> = (0..2)
            .map(|_| {
                let delegations = delegations.clone();
                let panes = panes.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    delegations.begin_follow_up("delegation-1", &panes)
                })
            })
            .collect();
        barrier.wait();
        let claims: Vec<_> = claims
            .into_iter()
            .map(|claim| claim.join().unwrap())
            .collect();

        assert_eq!(claims.iter().filter(|claim| claim.is_ok()).count(), 1);
        assert_eq!(claims.iter().filter(|claim| claim.is_err()).count(), 1);
    }

    #[test]
    fn delegated_agent_changes_freeze_at_idle_and_extend_across_follow_ups() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .current_dir(&repo)
                .args(args)
                .status()
                .unwrap()
                .success());
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        fs::write(repo.join("file.txt"), "before\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "initial"]);

        let worktree_path = repo.to_str().unwrap();
        let delegations = AgentDelegations::default();
        let panes = AgentPaneStatuses::default();
        delegations.open(
            "delegation-1",
            worktree_path,
            Some("Luna implementation"),
            None,
            None,
        );
        assert!(delegations.register("delegation-1", "pane-1"));
        delegations.observe_hook(worktree_path, "pane-1", &panes, "working");
        fs::write(repo.join("file.txt"), "first\n").unwrap();

        let first = delegations
            .finish(worktree_path, "pane-1")
            .unwrap()
            .unwrap();
        assert_eq!(first.files, 1);
        assert_eq!(first.name.as_deref(), Some("Luna implementation"));
        assert!(first.finished);

        fs::write(repo.join("file.txt"), "unrelated later edit\n").unwrap();
        let frozen = delegations
            .changes(worktree_path, "pane-1")
            .unwrap()
            .unwrap();
        let frozen_blob =
            crate::git::blob_sha_at_ref(worktree_path, &frozen.content_ref, "file.txt").unwrap();
        let current_blob = crate::git::hash_worktree_file(worktree_path, "file.txt").unwrap();
        assert_ne!(frozen_blob, current_blob);
        assert!(frozen.diff.contains("+first"));
        assert!(!frozen.diff.contains("+unrelated later edit"));
        assert_eq!(frozen.changed_files.len(), frozen.summary.files as usize);

        panes.observe(worktree_path, "pane-1", "idle");
        assert!(delegations.begin_follow_up("delegation-1", &panes).is_ok());
        delegations.observe_hook(worktree_path, "pane-1", &panes, "working");
        fs::write(repo.join("follow-up.txt"), "review fix\n").unwrap();
        let follow_up = delegations
            .finish(worktree_path, "pane-1")
            .unwrap()
            .unwrap();
        assert_eq!(follow_up.files, 2);
    }

    #[test]
    fn browser_skill_requires_impala_runtime_context() {
        // Guard must not key on per-pane env vars: Codex app-server sessions
        // run commands daemon-side, where those vars never exist.
        assert!(IMPALA_BROWSER_SKILL.contains("test -f ~/.impala/hook-port"));
        assert!(!IMPALA_BROWSER_SKILL.contains("IMPALA_WORKTREE_PATH"));
        assert!(IMPALA_BROWSER_SKILL.contains("If the command fails, stop using this skill"));
    }

    #[test]
    fn hook_command_uses_the_live_inherited_port_without_pane_identity() {
        let temp = tempfile::tempdir().unwrap();
        let bin_dir = temp.path().join("bin");
        let impala_dir = temp.path().join(".impala");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::create_dir_all(&impala_dir).unwrap();
        fs::write(impala_dir.join("hook-port"), "60920").unwrap();

        let curl_path = bin_dir.join("curl");
        fs::write(
            &curl_path,
            r#"#!/bin/sh
printf '%s\n' "$*" >> "$CURL_LOG"
case "$*" in
  *"http://127.0.0.1:60158/") exit 0 ;;
esac
cat >/dev/null
"#,
        )
        .unwrap();
        fs::set_permissions(&curl_path, fs::Permissions::from_mode(0o755)).unwrap();

        let log_path = temp.path().join("curl.log");
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(hook_command("Stop"))
            .env("HOME", temp.path())
            .env("PATH", format!("{}:/usr/bin:/bin", bin_dir.display()))
            .env("CURL_LOG", &log_path)
            .env("IMPALA_HOOK_PORT", "60158")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(br#"{"turn_id":"turn-1"}"#)
            .unwrap();
        assert!(child.wait().unwrap().success());

        let invocations = fs::read_to_string(log_path).unwrap();
        assert_eq!(invocations.matches("http://127.0.0.1:60158").count(), 2);
        assert!(!invocations.contains("http://127.0.0.1:60920"));
        assert!(!hook_command("Stop").contains("ACTIVE_APP_SERVER"));
        assert!(!hook_command("Stop").contains("target_app_server"));
    }

    #[test]
    fn stop_waits_for_background_tools_before_completing_an_automation_turn() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        assert!(!tracker.observe(
            worktree,
            pane,
            "UserPromptSubmit",
            r#"{"turn_id":"turn-1"}"#,
        ));
        assert!(!tracker.observe(
            worktree,
            pane,
            "PreToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-1"}"#,
        ));

        // Codex can stop the lead turn while a yielded exec is still running.
        assert!(!tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"turn-1"}"#));

        // Completion becomes eligible only when the outstanding tool finishes.
        assert!(tracker.observe(
            worktree,
            pane,
            "PostToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-1"}"#,
        ));
    }

    #[test]
    fn stop_completes_immediately_when_the_turn_has_no_active_tools() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        tracker.observe(
            worktree,
            pane,
            "UserPromptSubmit",
            r#"{"turn_id":"turn-1"}"#,
        );

        assert!(tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"turn-1"}"#));
        assert!(!tracker.has_active_tools(worktree, pane));
    }

    #[test]
    fn background_completion_waits_for_every_active_tool() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        tracker.observe(
            worktree,
            pane,
            "UserPromptSubmit",
            r#"{"turn_id":"turn-1"}"#,
        );
        tracker.observe(
            worktree,
            pane,
            "PreToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-1"}"#,
        );
        tracker.observe(
            worktree,
            pane,
            "PreToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-2"}"#,
        );
        assert!(!tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"turn-1"}"#));
        assert!(!tracker.observe(
            worktree,
            pane,
            "PostToolUse",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-1"}"#,
        ));
        assert!(tracker.has_active_tools(worktree, pane));
        assert!(tracker.observe(
            worktree,
            pane,
            "PostToolUseFailure",
            r#"{"turn_id":"turn-1","tool_use_id":"tool-2"}"#,
        ));
    }

    #[test]
    fn stale_stop_cannot_complete_a_newer_turn() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        tracker.observe(
            worktree,
            pane,
            "UserPromptSubmit",
            r#"{"turn_id":"turn-2"}"#,
        );

        assert!(!tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"turn-1"}"#));
    }

    #[test]
    fn an_unobserved_stop_cannot_prove_automation_completion() {
        let mut tracker = AutomationCompletionTracker::default();

        assert!(!tracker.observe(
            "/worktrees/restarted-automation",
            "tab-agent",
            "Stop",
            r#"{"turn_id":"turn-before-restart"}"#,
        ));
    }

    #[test]
    fn automation_completion_activity_is_isolated_by_pane() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";

        tracker.observe(
            worktree,
            "tab-agent",
            "UserPromptSubmit",
            r#"{"turn_id":"automation"}"#,
        );
        tracker.observe(
            worktree,
            "secondary-agent",
            "UserPromptSubmit",
            r#"{"turn_id":"manual"}"#,
        );
        tracker.observe(
            worktree,
            "tab-agent",
            "PreToolUse",
            r#"{"turn_id":"automation","tool_use_id":"tool-1"}"#,
        );

        assert!(tracker.observe(
            worktree,
            "secondary-agent",
            "Stop",
            r#"{"turn_id":"manual"}"#,
        ));
        assert!(!tracker.observe(worktree, "tab-agent", "Stop", r#"{"turn_id":"automation"}"#,));
        assert!(tracker.observe(
            worktree,
            "tab-agent",
            "PostToolUse",
            r#"{"turn_id":"automation","tool_use_id":"tool-1"}"#,
        ));
    }

    #[test]
    fn a_child_turn_can_finish_its_background_tool_after_the_lead_stops() {
        let mut tracker = AutomationCompletionTracker::default();
        let worktree = "/worktrees/automation";
        let pane = "tab-agent";

        tracker.observe(worktree, pane, "UserPromptSubmit", r#"{"turn_id":"lead"}"#);
        tracker.observe(
            worktree,
            pane,
            "PreToolUse",
            r#"{"turn_id":"child","tool_use_id":"tool-1"}"#,
        );
        assert!(!tracker.observe(worktree, pane, "Stop", r#"{"turn_id":"lead"}"#));
        assert!(tracker.observe(
            worktree,
            pane,
            "PostToolUse",
            r#"{"turn_id":"child","tool_use_id":"tool-1"}"#,
        ));
    }

    #[test]
    fn late_hooks_stay_suppressed_until_a_new_turn_starts() {
        let interrupted = InterruptedAgentTurns::default();
        let worktree = "/worktrees/interrupted";
        let pane = "pane-1";

        interrupted.mark(worktree, pane);
        assert!(interrupted.suppresses(worktree, pane, "PostToolUseFailure"));
        assert!(interrupted.suppresses(worktree, pane, "Stop"));
        assert!(!interrupted.suppresses(worktree, pane, "UserPromptSubmit"));
        assert!(!interrupted.suppresses(worktree, pane, "PostToolUse"));
    }

    #[test]
    fn interrupted_turn_suppression_is_scoped_to_one_pane() {
        let interrupted = InterruptedAgentTurns::default();
        let worktree = "/worktrees/interrupted";

        interrupted.mark(worktree, "pane-1");

        assert!(interrupted.suppresses(worktree, "pane-1", "Stop"));
        assert!(!interrupted.suppresses(worktree, "pane-2", "Stop"));
    }

    #[test]
    fn pane_statuses_keep_the_worktree_active_until_every_agent_is_idle() {
        let panes = AgentPaneStatuses::default();
        let worktree = "/worktrees/multiple-agents";

        assert_eq!(panes.observe(worktree, "pane-1", "working"), "working");
        assert_eq!(panes.observe(worktree, "pane-2", "working"), "working");
        assert_eq!(
            panes.interrupt(worktree, "pane-1"),
            Some("working".to_owned())
        );
        assert_eq!(panes.interrupt(worktree, "pane-2"), Some("idle".to_owned()));
    }

    #[test]
    fn shell_interrupts_do_not_change_agent_lifecycle() {
        let panes = AgentPaneStatuses::default();

        assert_eq!(panes.interrupt("/worktrees/shell", "terminal-pane"), None);
    }

    #[test]
    fn clearing_a_worktree_drops_every_persisted_pane_activity() {
        let panes = AgentPaneStatuses::default();
        let worktree = "/worktrees/removed";
        panes.observe(worktree, "pane-1", "working");
        panes.observe(worktree, "pane-2", "permission");

        assert!(panes.clear_worktree(worktree));
        assert!(panes.snapshot().is_empty());
        assert!(!panes.clear_worktree(worktree));
    }

    #[test]
    fn permission_has_priority_in_the_worktree_aggregate() {
        let panes = AgentPaneStatuses::default();
        let worktree = "/worktrees/permissions";

        panes.observe(worktree, "pane-1", "working");
        assert_eq!(
            panes.observe(worktree, "pane-2", "permission"),
            "permission"
        );
        assert_eq!(panes.observe(worktree, "pane-2", "idle"), "working");
    }

    #[test]
    fn a_trailing_post_tool_use_does_not_resurrect_an_idle_pane() {
        // A backgrounded tool's PostToolUse lands after the turn's Stop
        // already cleared the pane — nothing may come back to "working".
        assert_eq!(
            pane_status_for_hook_event("PostToolUse", false, false, false),
            ""
        );
        assert_eq!(
            pane_status_for_hook_event("PostToolUseFailure", false, false, false),
            ""
        );
    }

    #[test]
    fn post_tool_use_during_an_active_turn_keeps_the_pane_working() {
        assert_eq!(
            pane_status_for_hook_event("PostToolUse", false, false, true),
            "working"
        );
    }

    #[test]
    fn a_new_turn_raises_status_from_a_prompt_or_tool_call() {
        assert_eq!(
            pane_status_for_hook_event("UserPromptSubmit", false, false, false),
            "working"
        );
        assert_eq!(
            pane_status_for_hook_event("PreToolUse", false, false, false),
            "working"
        );
        assert_eq!(
            pane_status_for_hook_event("PermissionRequest", false, false, false),
            "permission"
        );
    }

    #[test]
    fn automation_completion_still_drains_to_idle_through_trailing_tools() {
        // An automation's lead turn stops while background tools run: Stop
        // keeps it working, and the final draining PostToolUse completes it.
        assert_eq!(
            pane_status_for_hook_event("Stop", false, true, true),
            "working"
        );
        assert_eq!(
            pane_status_for_hook_event("PostToolUse", true, false, true),
            "idle"
        );
    }

    #[test]
    fn a_vanished_wake_target_is_settled_instead_of_retried() {
        // Verbatim app-server message for a thread it no longer knows.
        assert!(wake_target_is_gone(
            "thread not found: 01a01f50-762e-7130-aca8-d2df719c9622"
        ));
        // A busy or still-starting turn is exactly what the retry is for.
        assert!(!wake_target_is_gone("turn already in progress"));
        assert!(!wake_target_is_gone(
            "connect Codex app-server: No such file or directory"
        ));
    }
}
