use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSummary {
    pub id: String,
    pub name: String,
    pub status: String,
    pub depth: usize,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSnapshot {
    pub agents: Vec<SubagentSummary>,
    pub previous_agents: Vec<SubagentSummary>,
    pub active_count: usize,
}

#[derive(Clone, Debug)]
struct SubagentRecord {
    summary: SubagentSummary,
    started_at: i64,
}

#[derive(Clone, Default)]
struct PaneSession {
    session_id: String,
    provider: String,
    current_turn_started_at: i64,
    agents: HashMap<String, SubagentRecord>,
}

#[derive(Default)]
pub struct SubagentRegistry(Mutex<HashMap<String, PaneSession>>);

fn pane_key(worktree_path: &str, pane_id: &str) -> String {
    format!("{worktree_path}\0{pane_id}")
}

impl SubagentRegistry {
    pub fn ingest_hook(
        &self,
        app: &AppHandle,
        worktree_path: &str,
        pane_id: &str,
        provider: &str,
        event_type: &str,
        payload: &str,
    ) {
        if worktree_path.is_empty() || pane_id.is_empty() || payload.is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        let session_id = value
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if session_id.is_empty() {
            return;
        }
        let session_files = codex_session_files(worktree_path, session_id);
        let runtime_provider = detect_runtime_provider(
            provider,
            &value,
            find_session_file_for_worktree(&session_files, session_id, worktree_path, None)
                .is_some(),
        );

        let key = pane_key(worktree_path, pane_id);
        let mut changed = false;
        if let Ok(mut sessions) = self.0.lock() {
            let session = sessions.entry(key).or_default();
            if session.session_id != session_id || session.provider != runtime_provider {
                session.session_id = session_id.to_string();
                session.provider = runtime_provider.to_string();
                session.current_turn_started_at = 0;
                session.agents.clear();
                changed = true;
            }

            if event_type == "UserPromptSubmit" {
                changed |= begin_main_turn(session, chrono::Utc::now().timestamp_millis());
            }

            if runtime_provider == "claude" {
                changed |= ingest_claude_event(session, event_type, &value);
            } else if runtime_provider == "codex" {
                changed |= refresh_codex_session_from_files(session, &session_files, worktree_path);
            }
        }

        if changed {
            let _ = app.emit(
                "subagents-changed",
                serde_json::json!({
                    "worktreePath": worktree_path,
                    "paneId": pane_id,
                }),
            );
        }
    }

    pub fn snapshot(&self, worktree_path: &str, pane_id: &str) -> SubagentSnapshot {
        let key = pane_key(worktree_path, pane_id);
        let (mut current, mut previous) = self
            .0
            .lock()
            .ok()
            .and_then(|mut sessions| {
                let session = sessions.get_mut(&key)?;
                if session.provider == "codex" {
                    let session_files = codex_session_files(worktree_path, &session.session_id);
                    refresh_codex_session_from_files(session, &session_files, worktree_path);
                }
                Some(
                    session
                        .agents
                        .values()
                        .cloned()
                        .partition::<Vec<_>, _>(|record| {
                            record.summary.status == "running"
                                || record.started_at >= session.current_turn_started_at
                        }),
                )
            })
            .unwrap_or_default();
        current.sort_by(|left, right| {
            left.started_at
                .cmp(&right.started_at)
                .then_with(|| left.summary.name.cmp(&right.summary.name))
                .then_with(|| left.summary.id.cmp(&right.summary.id))
        });
        previous.sort_by(|left, right| {
            right
                .summary
                .updated_at
                .cmp(&left.summary.updated_at)
                .then_with(|| left.summary.name.cmp(&right.summary.name))
                .then_with(|| left.summary.id.cmp(&right.summary.id))
        });
        let agents = current
            .into_iter()
            .map(|record| record.summary)
            .collect::<Vec<_>>();
        let previous_agents = previous
            .into_iter()
            .map(|record| record.summary)
            .collect::<Vec<_>>();
        let active_count = agents
            .iter()
            .filter(|agent| agent.status == "running")
            .count();
        SubagentSnapshot {
            agents,
            previous_agents,
            active_count,
        }
    }
}

fn begin_main_turn(session: &mut PaneSession, started_at: i64) -> bool {
    if session.current_turn_started_at == started_at {
        return false;
    }
    session.current_turn_started_at = started_at;
    true
}

fn detect_runtime_provider<'a>(
    configured_provider: &'a str,
    payload: &Value,
    codex_session_found: bool,
) -> &'a str {
    if codex_session_found {
        "codex"
    } else if payload.get("agent_id").is_some()
        || payload.get("transcript_path").is_some()
        || payload.get("agent_transcript_path").is_some()
    {
        "claude"
    } else {
        configured_provider
    }
}

fn ingest_claude_event(session: &mut PaneSession, event_type: &str, value: &Value) -> bool {
    let Some(agent_id) = value.get("agent_id").and_then(Value::as_str) else {
        return false;
    };
    // Claude Code encodes "type unknown" as agent_type: "" (the payload
    // schema requires a string), and SubagentStop for background agents can
    // be the only event that ever names a record — keep any name we already
    // learned instead of clobbering it.
    let name = value
        .get("agent_type")
        .and_then(Value::as_str)
        .filter(|agent_type| !agent_type.is_empty())
        .map(str::to_string)
        .or_else(|| {
            session
                .agents
                .get(agent_id)
                .map(|record| record.summary.name.clone())
        })
        .unwrap_or_else(|| "Subagent".to_string());
    let now = chrono::Utc::now().timestamp_millis();
    let status = if event_type == "SubagentStop" {
        "done"
    } else {
        "running"
    };
    let next = SubagentRecord {
        summary: SubagentSummary {
            id: agent_id.to_string(),
            name,
            status: status.to_string(),
            depth: 1,
            updated_at: now,
        },
        started_at: session
            .agents
            .get(agent_id)
            .map(|record| record.started_at)
            .unwrap_or(now),
    };
    let changed = session
        .agents
        .get(agent_id)
        .map(|old| {
            old.summary.status != next.summary.status
                || old.summary.updated_at != next.summary.updated_at
        })
        .unwrap_or(true);
    session.agents.insert(agent_id.to_string(), next);
    changed
}

fn refresh_codex_session_from_files(
    session: &mut PaneSession,
    session_files: &[PathBuf],
    worktree_path: &str,
) -> bool {
    let Some(parent_path) =
        find_session_file_for_worktree(session_files, &session.session_id, worktree_path, None)
    else {
        return false;
    };
    let Ok(contents) = fs::read_to_string(parent_path) else {
        return false;
    };

    let mut next: HashMap<String, SubagentRecord> = HashMap::new();
    for line in contents.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = &value["payload"];
        if value["type"] == "event_msg" && payload["type"] == "task_started" {
            if let Some(started_at) = payload["started_at"].as_i64() {
                session.current_turn_started_at = session
                    .current_turn_started_at
                    .max(started_at.saturating_mul(1_000));
            }
            continue;
        }
        if value["type"] != "event_msg" || payload["type"] != "sub_agent_activity" {
            continue;
        }
        if payload["kind"] != "started" {
            continue;
        }
        let Some(thread_id) = payload["agent_thread_id"].as_str() else {
            continue;
        };
        let Some(agent_path) = payload["agent_path"].as_str() else {
            continue;
        };
        if agent_path == "/root" {
            continue;
        }
        let transcript_path = find_session_file_for_worktree(
            session_files,
            thread_id,
            worktree_path,
            Some(agent_path),
        );
        let completed = transcript_path
            .as_deref()
            .is_some_and(codex_session_is_complete);
        let name = agent_path.rsplit('/').next().unwrap_or("Subagent");
        let depth = agent_path
            .split('/')
            .filter(|part| !part.is_empty())
            .count()
            .saturating_sub(1);
        next.insert(
            thread_id.to_string(),
            SubagentRecord {
                summary: SubagentSummary {
                    id: thread_id.to_string(),
                    name: name.to_string(),
                    status: if completed { "done" } else { "running" }.to_string(),
                    depth,
                    updated_at: payload["occurred_at_ms"].as_i64().unwrap_or_default(),
                },
                started_at: payload["occurred_at_ms"].as_i64().unwrap_or_default(),
            },
        );
    }
    let changed = !same_agent_state(&session.agents, &next);
    session.agents = next;
    changed
}

fn codex_session_files(worktree_path: &str, session_id: &str) -> Vec<PathBuf> {
    let canonical_home = crate::agent_config::codex_home_path();
    codex_session_files_in(worktree_path, session_id, canonical_home.as_deref())
}

pub(crate) fn migrate_legacy_codex_session(
    worktree_path: &str,
    session_id: &str,
    canonical_home: &Path,
) -> Result<bool, String> {
    let canonical_roots = [
        canonical_home.join("sessions"),
        canonical_home.join("archived_sessions"),
    ];
    if find_codex_session_file(&canonical_roots, session_id, worktree_path, None).is_some() {
        return Ok(false);
    }

    let legacy_root = Path::new(worktree_path)
        .join(".impala")
        .join("codex")
        .join("sessions");
    let Some(source) = find_codex_session_file(
        std::slice::from_ref(&legacy_root),
        session_id,
        worktree_path,
        None,
    ) else {
        return Ok(false);
    };
    if codex_session_metadata_identity_matches(&source, session_id, worktree_path, None)
        != Some(true)
    {
        return Err(format!(
            "legacy Codex session {} has no matching session metadata",
            source.display()
        ));
    }

    let relative = source
        .strip_prefix(&legacy_root)
        .map_err(|e| format!("resolve legacy Codex session path: {e}"))?;
    let destination = canonical_home.join("sessions").join(relative);
    let parent = destination
        .parent()
        .ok_or_else(|| "canonical Codex session has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("mkdir canonical Codex session directory: {e}"))?;
    let mut input = fs::File::open(&source)
        .map_err(|e| format!("open legacy Codex session {}: {e}", source.display()))?;
    let temp = destination.with_extension(format!("jsonl.impala-migrate-{}", uuid::Uuid::new_v4()));
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| format!("create migration file {}: {e}", temp.display()))?;
    let copied = std::io::copy(&mut input, &mut output)
        .map_err(|e| format!("copy legacy Codex session {}: {e}", source.display()))
        .and_then(|_| {
            output.sync_all().map_err(|e| {
                format!(
                    "sync canonical Codex session {}: {e}",
                    destination.display()
                )
            })
        });
    if let Err(error) = copied {
        drop(output);
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    drop(output);

    let published = match fs::hard_link(&temp, &destination) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if codex_session_metadata_matches(&destination, session_id, worktree_path, None) {
                Ok(false)
            } else {
                Err(format!(
                    "canonical Codex session {} already exists but has different metadata",
                    destination.display()
                ))
            }
        }
        Err(error) => Err(format!(
            "publish canonical Codex session {}: {error}",
            destination.display()
        )),
    };
    let _ = fs::remove_file(temp);
    published
}

fn codex_session_files_in(
    worktree_path: &str,
    session_id: &str,
    canonical_home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = vec![Path::new(worktree_path)
        .join(".impala")
        .join("codex")
        .join("sessions")];
    if let Some(home) = canonical_home {
        for root in [home.join("sessions"), home.join("archived_sessions")] {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }

    let Some(parent) = find_codex_session_file(&roots, session_id, worktree_path, None) else {
        return Vec::new();
    };
    let mut files = vec![parent.clone()];
    let Ok(contents) = fs::read_to_string(parent) else {
        return files;
    };
    for line in contents.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = &value["payload"];
        if value["type"] != "event_msg"
            || payload["type"] != "sub_agent_activity"
            || payload["kind"] != "started"
        {
            continue;
        }
        let (Some(thread_id), Some(agent_path)) = (
            payload["agent_thread_id"].as_str(),
            payload["agent_path"].as_str(),
        ) else {
            continue;
        };
        if let Some(path) =
            find_codex_session_file(&roots, thread_id, worktree_path, Some(agent_path))
        {
            files.push(path);
        }
    }
    files
}

fn same_agent_state(
    left: &HashMap<String, SubagentRecord>,
    right: &HashMap<String, SubagentRecord>,
) -> bool {
    left.len() == right.len()
        && left.iter().all(|(id, old)| {
            right.get(id).is_some_and(|new| {
                old.summary.status == new.summary.status
                    && old.summary.updated_at == new.summary.updated_at
                    && old.started_at == new.started_at
            })
        })
}

#[derive(Clone)]
struct CodexSessionPathCacheEntry {
    path: Option<PathBuf>,
    roots_signature: Vec<Option<std::time::SystemTime>>,
}

static CODEX_SESSION_PATHS: OnceLock<Mutex<HashMap<String, CodexSessionPathCacheEntry>>> =
    OnceLock::new();

fn codex_session_roots_signature(roots: &[PathBuf]) -> Vec<Option<std::time::SystemTime>> {
    let today = chrono::Utc::now().format("%Y/%m/%d").to_string();
    roots
        .iter()
        .flat_map(|root| [root.clone(), root.join(&today)])
        .map(|path| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
        })
        .collect()
}

fn find_codex_session_file(
    roots: &[PathBuf],
    session_id: &str,
    worktree_path: &str,
    expected_agent_path: Option<&str>,
) -> Option<PathBuf> {
    let key = format!(
        "{worktree_path}\0{session_id}\0{}\0{}",
        expected_agent_path.unwrap_or_default(),
        roots
            .iter()
            .map(|root| root.to_string_lossy())
            .collect::<Vec<_>>()
            .join("\0")
    );
    let cache = CODEX_SESSION_PATHS.get_or_init(|| Mutex::new(HashMap::new()));
    let roots_signature = codex_session_roots_signature(roots);
    if let Some(entry) = cache.lock().ok()?.get(&key).cloned() {
        if let Some(path) = entry.path.filter(|path| path.exists()) {
            return Some(path);
        }
        if entry.roots_signature == roots_signature {
            return None;
        }
    }

    let mut candidates = Vec::new();
    for root in roots {
        collect_session_files_for_id(root, session_id, &mut candidates);
    }
    let path =
        find_session_file_for_worktree(&candidates, session_id, worktree_path, expected_agent_path);
    cache.lock().ok()?.insert(
        key,
        CodexSessionPathCacheEntry {
            path: path.clone(),
            roots_signature,
        },
    );
    path
}

fn collect_session_files_for_id(root: &Path, session_id: &str, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_files_for_id(&path, session_id, files);
        } else if codex_rollout_filename_matches(&path, session_id) {
            files.push(path);
        }
    }
}

fn codex_rollout_filename_matches(path: &Path, session_id: &str) -> bool {
    let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };
    path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
        && (stem == session_id || stem.ends_with(&format!("-{session_id}")))
}

fn find_session_file_for_worktree(
    files: &[PathBuf],
    session_id: &str,
    worktree_path: &str,
    expected_agent_path: Option<&str>,
) -> Option<PathBuf> {
    files
        .iter()
        .filter(|path| {
            let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
                return false;
            };
            stem == session_id || stem.ends_with(&format!("-{session_id}"))
        })
        .find(|path| {
            codex_session_metadata_matches(path, session_id, worktree_path, expected_agent_path)
        })
        .cloned()
}

fn codex_session_metadata_matches(
    path: &Path,
    session_id: &str,
    worktree_path: &str,
    expected_agent_path: Option<&str>,
) -> bool {
    let legacy_root = Path::new(worktree_path)
        .join(".impala")
        .join("codex")
        .join("sessions");
    codex_session_metadata_identity_matches(path, session_id, worktree_path, expected_agent_path)
        .unwrap_or_else(|| path.starts_with(legacy_root))
}

fn codex_session_metadata_identity_matches(
    path: &Path,
    session_id: &str,
    worktree_path: &str,
    expected_agent_path: Option<&str>,
) -> Option<bool> {
    let contents = fs::read_to_string(path).ok()?;
    for line in contents.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value["type"] != "session_meta" {
            continue;
        }
        let payload = &value["payload"];
        let file_session_id = payload["id"]
            .as_str()
            .or_else(|| payload["session_id"].as_str());
        if file_session_id != Some(session_id) || payload["cwd"].as_str() != Some(worktree_path) {
            return Some(false);
        }
        if let Some(agent_path) = payload["agent_path"].as_str() {
            let expected = expected_agent_path.unwrap_or("/root");
            if agent_path != expected {
                return Some(false);
            }
        }
        return Some(true);
    }
    None
}

fn codex_session_is_complete(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|contents| {
        contents.lines().rev().any(|line| {
            serde_json::from_str::<Value>(line).is_ok_and(|value| {
                value["type"] == "event_msg" && value["payload"]["type"] == "task_complete"
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "impala-subagents-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    #[test]
    fn explicit_resume_copies_legacy_session_without_removing_or_overwriting_it() {
        let workspace = temp_workspace("legacy-resume");
        let canonical = temp_workspace("canonical-resume");
        let relative = Path::new("2026/08/05/rollout-parent-session.jsonl");
        let legacy = workspace.join(".impala/codex/sessions").join(relative);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let body = serde_json::json!({
            "type": "session_meta",
            "payload": {
                "id": "parent-session",
                "cwd": workspace.to_string_lossy(),
                "agent_path": "/root"
            }
        })
        .to_string();
        fs::write(&legacy, format!("{body}\n")).unwrap();

        assert!(migrate_legacy_codex_session(
            workspace.to_str().unwrap(),
            "parent-session",
            &canonical,
        )
        .unwrap());
        let migrated = canonical.join("sessions").join(relative);
        assert_eq!(fs::read_to_string(&migrated).unwrap(), format!("{body}\n"));
        assert!(legacy.exists());

        fs::write(&legacy, "changed legacy source\n").unwrap();
        assert!(!migrate_legacy_codex_session(
            workspace.to_str().unwrap(),
            "parent-session",
            &canonical,
        )
        .unwrap());
        assert_eq!(fs::read_to_string(&migrated).unwrap(), format!("{body}\n"));

        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(canonical).unwrap();
    }

    #[test]
    fn explicit_resume_rejects_legacy_session_without_matching_metadata() {
        let workspace = temp_workspace("legacy-resume-invalid");
        let canonical = temp_workspace("canonical-resume-invalid");
        let legacy =
            workspace.join(".impala/codex/sessions/2026/08/05/rollout-parent-session.jsonl");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, "{\"type\":\"event_msg\"}\n").unwrap();

        let error =
            migrate_legacy_codex_session(workspace.to_str().unwrap(), "parent-session", &canonical)
                .unwrap_err();
        assert!(error.contains("has no matching session metadata"));
        assert!(legacy.exists());
        assert!(!canonical.join("sessions").exists());

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn tracks_claude_subagent_lifecycle() {
        let mut session = PaneSession::default();
        assert!(ingest_claude_event(
            &mut session,
            "SubagentStart",
            &serde_json::json!({
                "agent_id": "agent-1",
                "agent_type": "Explore",
                "transcript_path": "/tmp/session.jsonl"
            }),
        ));
        let running = session.agents.get("agent-1").unwrap();
        assert_eq!(running.summary.status, "running");
        assert_eq!(running.summary.name, "Explore");

        assert!(ingest_claude_event(
            &mut session,
            "SubagentStop",
            &serde_json::json!({
                "agent_id": "agent-1",
                "agent_type": "Explore",
                "last_assistant_message": "Finished"
            }),
        ));
        let done = session.agents.get("agent-1").unwrap();
        assert_eq!(done.summary.status, "done");
    }

    #[test]
    fn empty_agent_type_on_stop_keeps_the_name_from_start() {
        let mut session = PaneSession::default();
        ingest_claude_event(
            &mut session,
            "SubagentStart",
            &serde_json::json!({
                "agent_id": "agent-1",
                "agent_type": "Explore"
            }),
        );
        ingest_claude_event(
            &mut session,
            "SubagentStop",
            &serde_json::json!({
                "agent_id": "agent-1",
                "agent_type": ""
            }),
        );
        let done = session.agents.get("agent-1").unwrap();
        assert_eq!(done.summary.name, "Explore");
        assert_eq!(done.summary.status, "done");
    }

    #[test]
    fn stop_only_record_with_empty_agent_type_gets_placeholder_name() {
        let mut session = PaneSession::default();
        ingest_claude_event(
            &mut session,
            "SubagentStop",
            &serde_json::json!({
                "agent_id": "agent-1",
                "agent_type": ""
            }),
        );
        assert_eq!(
            session.agents.get("agent-1").unwrap().summary.name,
            "Subagent"
        );
    }

    #[test]
    fn manual_codex_session_overrides_claude_pane_provider() {
        let payload = serde_json::json!({ "session_id": "codex-session" });
        assert_eq!(detect_runtime_provider("claude", &payload, true), "codex");
    }

    #[test]
    fn claude_subagent_payload_overrides_codex_pane_provider() {
        let payload = serde_json::json!({
            "session_id": "claude-session",
            "agent_id": "agent-1"
        });
        assert_eq!(detect_runtime_provider("codex", &payload, false), "claude");
    }

    #[test]
    fn discovers_codex_subagent_and_completion() {
        let workspace = temp_workspace("codex");
        let sessions = workspace.join(".impala/codex/sessions/2026/07/22");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("rollout-parent-session.jsonl"),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "sub_agent_activity",
                    "kind": "started",
                    "agent_thread_id": "child-session",
                    "agent_path": "/root/reviewer",
                    "occurred_at_ms": 42
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            sessions.join("rollout-child-session.jsonl"),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "task_complete",
                    "last_agent_message": "Review complete"
                }
            })
            .to_string(),
        )
        .unwrap();

        let mut session = PaneSession {
            session_id: "parent-session".to_string(),
            provider: "codex".to_string(),
            current_turn_started_at: 0,
            agents: HashMap::new(),
        };
        let files = codex_session_files(workspace.to_str().unwrap(), "parent-session");
        assert!(refresh_codex_session_from_files(
            &mut session,
            &files,
            workspace.to_str().unwrap(),
        ));
        let child = session.agents.get("child-session").unwrap();
        assert_eq!(child.summary.name, "reviewer");
        assert_eq!(child.summary.depth, 1);
        assert_eq!(child.summary.status, "done");

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn discovers_codex_subagent_from_canonical_sessions_with_identity_filters() {
        let workspace = temp_workspace("canonical-codex");
        let canonical = temp_workspace("canonical-home");
        let sessions = canonical.join("sessions/2026/08/05");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        let worktree = workspace.to_string_lossy().to_string();
        fs::write(
            sessions.join("rollout-parent-session.jsonl"),
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "parent-session",
                        "cwd": worktree.clone(),
                        "agent_path": null
                    }
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "sub_agent_activity",
                        "kind": "started",
                        "agent_thread_id": "child-session",
                        "agent_path": "/root/reviewer",
                        "occurred_at_ms": 42
                    }
                }),
            ]
            .into_iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        )
        .unwrap();
        fs::write(
            sessions.join("rollout-child-session.jsonl"),
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "child-session",
                        "cwd": worktree.clone(),
                        "agent_path": "/root/reviewer"
                    }
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_complete" }
                }),
            ]
            .into_iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        )
        .unwrap();

        let mut session = PaneSession {
            session_id: "parent-session".to_string(),
            provider: "codex".to_string(),
            current_turn_started_at: 0,
            agents: HashMap::new(),
        };
        let files = codex_session_files_in(
            workspace.to_str().unwrap(),
            "parent-session",
            Some(&canonical),
        );
        assert!(files.iter().all(|path| path.starts_with(&canonical)));
        assert!(refresh_codex_session_from_files(
            &mut session,
            &files,
            workspace.to_str().unwrap(),
        ));
        assert_eq!(session.agents["child-session"].summary.status, "done");

        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(canonical).unwrap();
    }

    #[test]
    fn canonical_codex_lookup_requires_session_metadata() {
        let workspace = temp_workspace("canonical-missing-metadata-worktree");
        let canonical = temp_workspace("canonical-missing-metadata-home");
        let sessions = canonical.join("sessions/2026/08/05");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("rollout-parent-session.jsonl"),
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "task_complete" }
            })
            .to_string(),
        )
        .unwrap();

        let files = codex_session_files_in(
            workspace.to_str().unwrap(),
            "parent-session",
            Some(&canonical),
        );
        assert!(find_session_file_for_worktree(
            &files,
            "parent-session",
            workspace.to_str().unwrap(),
            None,
        )
        .is_none());

        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(canonical).unwrap();
    }

    #[test]
    fn snapshot_refreshes_codex_completion_written_after_last_hook() {
        let workspace = temp_workspace("codex-late-completion");
        let sessions = workspace.join(".impala/codex/sessions/2026/07/22");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("rollout-parent-session.jsonl"),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "sub_agent_activity",
                    "kind": "started",
                    "agent_thread_id": "child-session",
                    "agent_path": "/root/name_four",
                    "occurred_at_ms": 42
                }
            })
            .to_string(),
        )
        .unwrap();
        let child_path = sessions.join("rollout-child-session.jsonl");
        fs::write(&child_path, "").unwrap();

        let registry = SubagentRegistry::default();
        let key = pane_key(workspace.to_str().unwrap(), "agent-pane");
        let mut session = PaneSession {
            session_id: "parent-session".to_string(),
            provider: "codex".to_string(),
            current_turn_started_at: 0,
            agents: HashMap::new(),
        };
        let files = codex_session_files(workspace.to_str().unwrap(), "parent-session");
        assert!(refresh_codex_session_from_files(
            &mut session,
            &files,
            workspace.to_str().unwrap(),
        ));
        assert_eq!(session.agents["child-session"].summary.status, "running");
        registry.0.lock().unwrap().insert(key, session);

        fs::write(
            &child_path,
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "task_complete",
                    "last_agent_message": "Codex."
                }
            })
            .to_string(),
        )
        .unwrap();

        let snapshot = registry.snapshot(workspace.to_str().unwrap(), "agent-pane");
        assert_eq!(snapshot.active_count, 0);
        assert_eq!(snapshot.agents[0].status, "done");

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn new_main_turn_archives_done_agents_but_keeps_running_agents_current() {
        fn record(id: &str, status: &str, started_at: i64) -> SubagentRecord {
            SubagentRecord {
                summary: SubagentSummary {
                    id: id.to_string(),
                    name: id.to_string(),
                    status: status.to_string(),
                    depth: 1,
                    updated_at: started_at,
                },
                started_at,
            }
        }

        let workspace = temp_workspace("new-main-turn");
        let pane_id = "agent-pane";
        let key = pane_key(workspace.to_str().unwrap(), pane_id);
        let registry = SubagentRegistry::default();
        let mut session = PaneSession {
            session_id: "session".to_string(),
            provider: "claude".to_string(),
            current_turn_started_at: 0,
            agents: HashMap::from([
                ("old-done".to_string(), record("old-done", "done", 10)),
                (
                    "old-running".to_string(),
                    record("old-running", "running", 20),
                ),
                ("new-done".to_string(), record("new-done", "done", 110)),
            ]),
        };

        assert!(begin_main_turn(&mut session, 100));
        registry.0.lock().unwrap().insert(key, session);

        let snapshot = registry.snapshot(workspace.to_str().unwrap(), pane_id);
        let current_ids = snapshot
            .agents
            .iter()
            .map(|agent| agent.id.as_str())
            .collect::<Vec<_>>();
        let previous_ids = snapshot
            .previous_agents
            .iter()
            .map(|agent| agent.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(current_ids, vec!["old-running", "new-done"]);
        assert_eq!(previous_ids, vec!["old-done"]);
        assert_eq!(snapshot.active_count, 1);
    }

    #[test]
    fn snapshot_preserves_creation_order_when_an_agent_completes() {
        fn record(id: &str, status: &str, started_at: i64) -> SubagentRecord {
            SubagentRecord {
                summary: SubagentSummary {
                    id: id.to_string(),
                    name: id.to_string(),
                    status: status.to_string(),
                    depth: 1,
                    updated_at: started_at,
                },
                started_at,
            }
        }

        let workspace = temp_workspace("stable-row-order");
        let pane_id = "agent-pane";
        let key = pane_key(workspace.to_str().unwrap(), pane_id);
        let registry = SubagentRegistry::default();
        registry.0.lock().unwrap().insert(
            key.clone(),
            PaneSession {
                session_id: "session".to_string(),
                provider: "claude".to_string(),
                current_turn_started_at: 0,
                agents: HashMap::from([
                    ("first".to_string(), record("first", "running", 10)),
                    ("second".to_string(), record("second", "running", 20)),
                ]),
            },
        );

        let agent_ids = || {
            registry
                .snapshot(workspace.to_str().unwrap(), pane_id)
                .agents
                .into_iter()
                .map(|agent| agent.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(agent_ids(), vec!["first", "second"]);

        registry
            .0
            .lock()
            .unwrap()
            .get_mut(&key)
            .unwrap()
            .agents
            .get_mut("second")
            .unwrap()
            .summary
            .status = "done".to_string();

        assert_eq!(agent_ids(), vec!["first", "second"]);
    }

    #[test]
    fn codex_rollout_restores_latest_main_turn_after_restart() {
        let workspace = temp_workspace("codex-turn-restore");
        let sessions = workspace.join(".impala/codex/sessions/2026/07/23");
        fs::create_dir_all(&sessions).unwrap();
        let lines = [
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "task_started", "started_at": 100 }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "sub_agent_activity",
                    "kind": "started",
                    "agent_thread_id": "old-child",
                    "agent_path": "/root/old",
                    "occurred_at_ms": 100_100
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "task_started", "started_at": 200 }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "sub_agent_activity",
                    "kind": "started",
                    "agent_thread_id": "current-child",
                    "agent_path": "/root/current",
                    "occurred_at_ms": 200_100
                }
            }),
        ];
        fs::write(
            sessions.join("rollout-parent-session.jsonl"),
            lines
                .into_iter()
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        for child in ["old-child", "current-child"] {
            fs::write(
                sessions.join(format!("rollout-{child}.jsonl")),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "task_complete",
                        "last_agent_message": "Done"
                    }
                })
                .to_string(),
            )
            .unwrap();
        }

        let registry = SubagentRegistry::default();
        let key = pane_key(workspace.to_str().unwrap(), "agent-pane");
        registry.0.lock().unwrap().insert(
            key,
            PaneSession {
                session_id: "parent-session".to_string(),
                provider: "codex".to_string(),
                current_turn_started_at: 0,
                agents: HashMap::new(),
            },
        );

        let snapshot = registry.snapshot(workspace.to_str().unwrap(), "agent-pane");
        assert_eq!(snapshot.agents[0].id, "current-child");
        assert_eq!(snapshot.previous_agents[0].id, "old-child");

        fs::remove_dir_all(workspace).unwrap();
    }
}
