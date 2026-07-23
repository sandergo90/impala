use std::io::Write;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use chrono::TimeZone;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Automation {
    pub id: String,
    /// Project path, or "" for a global (project-less) automation — its runs
    /// execute in a fresh scratch git repo under ~/.impala/automation-runs.
    pub repo_path: String,
    pub name: String,
    pub prompt: String,
    pub agent: String,
    /// 5-field cron expression, evaluated in the machine's local timezone.
    pub schedule: String,
    pub enabled: bool,
    /// Unix seconds of the next fire. Precomputed on create/update/enable
    /// and after each fire so the scheduler tick is a plain index lookup.
    pub next_run_at: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewAutomation {
    pub repo_path: String,
    pub name: String,
    pub prompt: String,
    pub agent: String,
    pub schedule: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAutomation {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub agent: Option<String>,
    pub schedule: Option<String>,
    /// Moving the automation to another project.
    pub repo_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    /// Unix seconds of the slot this run covers (the automation's
    /// next_run_at at fire time — may be in the past for a catch-up run).
    pub scheduled_for: i64,
    pub worktree_path: Option<String>,
    /// Immutable Markdown snapshot passed to the agent for this run.
    pub instructions_path: Option<String>,
    /// pending → launched → completed | failed. aborted = the worktree was
    /// deleted while the run was in flight. skipped reserved.
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutomationDueEvent {
    pub run_id: String,
    pub automation: Automation,
    pub instructions_path: String,
    pub worktree_path: Option<String>,
}

const RUN_STATUSES: &[&str] = &[
    "pending",
    "launched",
    "completed",
    "failed",
    "aborted",
    "skipped",
];
const WORKTREE_CONTEXT_PLACEHOLDER: &str = "- Worktree: _pending allocation_";

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS automations (
            id TEXT PRIMARY KEY,
            repo_path TEXT NOT NULL,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            agent TEXT NOT NULL,
            schedule TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            next_run_at INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_automations_dispatch ON automations(enabled, next_run_at);
        CREATE INDEX IF NOT EXISTS idx_automations_repo ON automations(repo_path);
        CREATE TABLE IF NOT EXISTS automation_runs (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL,
            scheduled_for INTEGER NOT NULL,
            worktree_path TEXT,
            instructions_path TEXT,
            automation_snapshot TEXT,
            status TEXT NOT NULL,
            error TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(automation_id, scheduled_for)
        );
        CREATE INDEX IF NOT EXISTS idx_automation_runs_worktree ON automation_runs(worktree_path, status);",
    )
    .map_err(|e| format!("Failed to initialize automations tables: {}", e))?;
    // Phase 2 added `seen`; Phase-1 databases need the column. Errors
    // ("duplicate column name") mean it's already there.
    let _ = conn.execute(
        "ALTER TABLE automation_runs ADD COLUMN seen INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE automation_runs ADD COLUMN instructions_path TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE automation_runs ADD COLUMN automation_snapshot TEXT",
        [],
    );
    retry_orphaned_instruction_cleanup(conn)?;
    Ok(())
}

// --- cron -------------------------------------------------------------------

fn parse_schedule(schedule: &str) -> Result<cron::Schedule, String> {
    let fields = schedule.split_whitespace().count();
    if fields != 5 {
        return Err(format!(
            "Schedule must be a 5-field cron expression, got {} fields",
            fields
        ));
    }
    // The cron crate wants a seconds field; pin it to 0.
    cron::Schedule::from_str(&format!("0 {}", schedule.trim()))
        .map_err(|e| format!("Invalid schedule: {}", e))
}

/// Next occurrence strictly after `after_unix`, in local time.
pub fn next_occurrence(schedule: &str, after_unix: i64) -> Result<i64, String> {
    let sched = parse_schedule(schedule)?;
    let after = chrono::Local
        .timestamp_opt(after_unix, 0)
        .single()
        .ok_or_else(|| format!("Invalid timestamp: {}", after_unix))?;
    sched
        .after(&after)
        .next()
        .map(|dt| dt.timestamp())
        .ok_or_else(|| "Schedule has no future occurrences".to_string())
}

fn validate_agent(agent: &str) -> Result<(), String> {
    if agent != "claude" && agent != "codex" {
        return Err(format!("Invalid agent: {}", agent));
    }
    Ok(())
}

// --- rows -------------------------------------------------------------------

fn row_to_automation(row: &rusqlite::Row) -> rusqlite::Result<Automation> {
    let enabled: i64 = row.get(6)?;
    Ok(Automation {
        id: row.get(0)?,
        repo_path: row.get(1)?,
        name: row.get(2)?,
        prompt: row.get(3)?,
        agent: row.get(4)?,
        schedule: row.get(5)?,
        enabled: enabled != 0,
        next_run_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

const AUTOMATION_COLS: &str =
    "id, repo_path, name, prompt, agent, schedule, enabled, next_run_at, created_at, updated_at";

fn row_to_run(row: &rusqlite::Row) -> rusqlite::Result<AutomationRun> {
    Ok(AutomationRun {
        id: row.get(0)?,
        automation_id: row.get(1)?,
        scheduled_for: row.get(2)?,
        worktree_path: row.get(3)?,
        instructions_path: row.get(4)?,
        status: row.get(5)?,
        error: row.get(6)?,
        created_at: row.get(7)?,
    })
}

const RUN_COLS: &str =
    "id, automation_id, scheduled_for, worktree_path, instructions_path, status, error, created_at";

fn get_run(conn: &Connection, id: &str) -> Result<AutomationRun, String> {
    conn.query_row(
        &format!("SELECT {RUN_COLS} FROM automation_runs WHERE id = ?1"),
        params![id],
        row_to_run,
    )
    .map_err(|e| format!("Run not found: {} ({})", id, e))
}

pub fn create_automation_row(
    conn: &Connection,
    new: NewAutomation,
    now: i64,
) -> Result<Automation, String> {
    validate_agent(&new.agent)?;
    let next_run_at = next_occurrence(&new.schedule, now)?;
    let id = uuid::Uuid::new_v4().to_string();
    let ts = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO automations (id, repo_path, name, prompt, agent, schedule, enabled, next_run_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9)",
        params![id, new.repo_path, new.name, new.prompt, new.agent, new.schedule, next_run_at, ts, ts],
    )
    .map_err(|e| format!("Failed to create automation: {}", e))?;
    get_automation(conn, &id)
}

pub fn get_automation(conn: &Connection, id: &str) -> Result<Automation, String> {
    conn.query_row(
        &format!("SELECT {AUTOMATION_COLS} FROM automations WHERE id = ?1"),
        params![id],
        row_to_automation,
    )
    .map_err(|_| format!("Automation not found: {}", id))
}

pub fn list_by_repo(conn: &Connection, repo_path: &str) -> Result<Vec<Automation>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {AUTOMATION_COLS} FROM automations WHERE repo_path = ?1 ORDER BY created_at ASC"
        ))
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    let rows = stmt
        .query_map(params![repo_path], row_to_automation)
        .map_err(|e| format!("Failed to query automations: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read automation: {}", e))
}

pub fn update_automation_row(
    conn: &Connection,
    id: &str,
    changes: UpdateAutomation,
    now: i64,
) -> Result<Automation, String> {
    let existing = get_automation(conn, id)?;
    let name = changes.name.unwrap_or(existing.name);
    let prompt = changes.prompt.unwrap_or(existing.prompt);
    let agent = changes.agent.unwrap_or(existing.agent);
    validate_agent(&agent)?;
    let schedule = changes.schedule.unwrap_or(existing.schedule);
    let repo_path = changes.repo_path.unwrap_or(existing.repo_path);
    // Recompute unconditionally: cheap, and correct whether or not the
    // schedule changed (an unchanged schedule recomputes to the same slot).
    let next_run_at = next_occurrence(&schedule, now)?;
    let ts = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE automations SET name = ?1, prompt = ?2, agent = ?3, schedule = ?4, repo_path = ?5, next_run_at = ?6, updated_at = ?7 WHERE id = ?8",
        params![name, prompt, agent, schedule, repo_path, next_run_at, ts, id],
    )
    .map_err(|e| format!("Failed to update automation: {}", e))?;
    get_automation(conn, id)
}

pub fn delete_automation_row(conn: &Connection, id: &str) -> Result<(), String> {
    let instruction_artifacts = instruction_artifacts_for_automation(conn, id)?;
    for artifact in &instruction_artifacts {
        remove_run_instructions(&artifact.run_id, &artifact.path)?;
    }
    conn.execute(
        "DELETE FROM automation_runs WHERE automation_id = ?1",
        params![id],
    )
    .map_err(|e| format!("Failed to delete automation runs: {}", e))?;
    let n = conn
        .execute("DELETE FROM automations WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete automation: {}", e))?;
    if n == 0 {
        return Err(format!("Automation not found: {}", id));
    }
    Ok(())
}

pub fn set_enabled_row(conn: &Connection, id: &str, enabled: bool, now: i64) -> Result<(), String> {
    let existing = get_automation(conn, id)?;
    // Resuming recomputes from now — occurrences missed while paused are
    // deliberately discarded.
    let next_run_at = if enabled {
        next_occurrence(&existing.schedule, now)?
    } else {
        existing.next_run_at
    };
    let ts = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE automations SET enabled = ?1, next_run_at = ?2, updated_at = ?3 WHERE id = ?4",
        params![enabled as i64, next_run_at, ts, id],
    )
    .map_err(|e| format!("Failed to set enabled: {}", e))?;
    Ok(())
}

fn due_automations(conn: &Connection, now: i64) -> Result<Vec<Automation>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {AUTOMATION_COLS} FROM automations WHERE enabled = 1 AND next_run_at <= ?1"
        ))
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    let rows = stmt
        .query_map(params![now], row_to_automation)
        .map_err(|e| format!("Failed to query due automations: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read automation: {}", e))
}

fn set_next_run_at(conn: &Connection, id: &str, next_run_at: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE automations SET next_run_at = ?1 WHERE id = ?2",
        params![next_run_at, id],
    )
    .map_err(|e| format!("Failed to advance next_run_at: {}", e))?;
    Ok(())
}

/// Insert a run for a slot. Returns None when the slot already has a run
/// (the UNIQUE(automation_id, scheduled_for) idempotency guard).
pub fn insert_run(
    conn: &Connection,
    automation_id: &str,
    scheduled_for: i64,
) -> Result<Option<AutomationRun>, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = chrono::Utc::now().to_rfc3339();
    let n = conn
        .execute(
            "INSERT OR IGNORE INTO automation_runs (id, automation_id, scheduled_for, status, created_at)
             VALUES (?1, ?2, ?3, 'pending', ?4)",
            params![id, automation_id, scheduled_for, ts],
        )
        .map_err(|e| format!("Failed to insert run: {}", e))?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(AutomationRun {
        id,
        automation_id: automation_id.to_string(),
        scheduled_for,
        worktree_path: None,
        instructions_path: None,
        status: "pending".to_string(),
        error: None,
        created_at: ts,
    }))
}

fn automation_run_storage_root() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("no home dir")?
        .join(".impala")
        .join("automation-runs"))
}

fn metadata_value(value: &str) -> String {
    value
        .replace(['\r', '\n'], " ")
        .replace('`', "'")
        .trim()
        .to_string()
}

fn render_run_instructions(run: &AutomationRun, automation: &Automation) -> String {
    let repository = if automation.repo_path.is_empty() {
        "Global automation (fresh scratch repository)".to_string()
    } else {
        metadata_value(&automation.repo_path)
    };
    let scheduled_for = chrono::Utc
        .timestamp_opt(run.scheduled_for, 0)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| run.scheduled_for.to_string());
    let mut markdown = format!(
        "# Automation Run\n\n\
         - Run ID: `{}`\n\
         - Automation ID: `{}`\n\
         - Automation: {}\n\
         - Agent: `{}`\n\
         - Repository: {}\n\
         {}\n\
         - Scheduled for: `{}`\n\
         - Created at: `{}`\n\n\
         ## Instructions\n\n",
        metadata_value(&run.id),
        metadata_value(&automation.id),
        metadata_value(&automation.name),
        metadata_value(&automation.agent),
        repository,
        WORKTREE_CONTEXT_PLACEHOLDER,
        scheduled_for,
        metadata_value(&run.created_at),
    );
    markdown.push_str(&automation.prompt);
    if !markdown.ends_with('\n') {
        markdown.push('\n');
    }
    markdown
}

fn ensure_run_instructions_at(
    root: &Path,
    run: &AutomationRun,
    automation: &Automation,
) -> Result<String, String> {
    let run_dir = root.join(&run.id);
    std::fs::create_dir_all(&run_dir)
        .map_err(|e| format!("create automation instructions directory: {}", e))?;
    let path = run_dir.join("AUTOMATION.md");
    let markdown = render_run_instructions(run, automation);

    if path.exists() {
        let existing = std::fs::read_to_string(&path)
            .map_err(|e| format!("read automation instructions: {}", e))?;
        if existing != markdown {
            return Err(format!(
                "refusing to overwrite immutable automation instructions: {}",
                path.display()
            ));
        }
        make_instructions_read_only(&path)?;
        return Ok(path.to_string_lossy().to_string());
    }

    let temporary_path = run_dir.join(format!(".AUTOMATION.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| -> Result<(), String> {
        let mut file = options
            .open(&temporary_path)
            .map_err(|e| format!("create automation instructions: {}", e))?;
        file.write_all(markdown.as_bytes())
            .map_err(|e| format!("write automation instructions: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("sync automation instructions: {}", e))?;
        make_instructions_read_only(&temporary_path)?;
        std::fs::rename(&temporary_path, &path)
            .map_err(|e| format!("publish automation instructions: {}", e))
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(path.to_string_lossy().to_string())
}

fn make_instructions_read_only(path: &Path) -> Result<(), String> {
    let mut permissions = std::fs::metadata(path)
        .map_err(|e| format!("read automation instructions permissions: {}", e))?
        .permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(path, permissions)
        .map_err(|e| format!("make automation instructions read-only: {}", e))
}

fn finalize_run_instructions(instructions_path: &Path, worktree_path: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(instructions_path)
        .map_err(|e| format!("read automation instructions: {}", e))?;
    let worktree_line = format!("- Worktree: `{}`", metadata_value(worktree_path));
    let finalized = if existing.contains(WORKTREE_CONTEXT_PLACEHOLDER) {
        existing.replacen(WORKTREE_CONTEXT_PLACEHOLDER, &worktree_line, 1)
    } else if existing.contains(&worktree_line) {
        return make_instructions_read_only(instructions_path);
    } else {
        return Err(format!(
            "automation instructions contain a different worktree context: {}",
            instructions_path.display()
        ));
    };

    let temporary_path = instructions_path.with_extension("md.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary_path)
        .map_err(|e| format!("create finalized automation instructions: {}", e))?;
    file.write_all(finalized.as_bytes())
        .map_err(|e| format!("write finalized automation instructions: {}", e))?;
    file.sync_all()
        .map_err(|e| format!("sync finalized automation instructions: {}", e))?;
    std::fs::rename(&temporary_path, instructions_path)
        .map_err(|e| format!("replace automation instructions: {}", e))?;

    make_instructions_read_only(instructions_path)
}

fn set_run_dispatch_snapshot(
    conn: &Connection,
    run_id: &str,
    instructions_path: &str,
    automation: &Automation,
) -> Result<(), String> {
    let automation_snapshot = serde_json::to_string(automation)
        .map_err(|e| format!("Failed to serialize automation snapshot: {}", e))?;
    conn.execute(
        "UPDATE automation_runs
         SET instructions_path = ?1, automation_snapshot = ?2
         WHERE id = ?3",
        params![instructions_path, automation_snapshot, run_id],
    )
    .map_err(|e| format!("Failed to store run dispatch snapshot: {}", e))?;
    Ok(())
}

fn remove_run_instructions_at(
    root: &Path,
    run_id: &str,
    instructions_path: &str,
) -> Result<(), String> {
    let run_dir = root.join(run_id);
    let expected = run_dir.join("AUTOMATION.md");
    if Path::new(instructions_path) != expected {
        return Err(format!(
            "refusing to delete unexpected automation instructions path: {}",
            instructions_path
        ));
    }
    if run_dir.exists() {
        std::fs::remove_dir_all(&run_dir)
            .map_err(|e| format!("delete automation instructions: {}", e))?;
    }
    Ok(())
}

fn remove_run_instructions(run_id: &str, instructions_path: &str) -> Result<(), String> {
    let root = automation_run_storage_root()?;
    remove_run_instructions_at(&root, run_id, instructions_path)
}

#[derive(Debug)]
struct RunInstructionsArtifact {
    run_id: String,
    path: String,
}

fn instruction_artifacts_for_automation(
    conn: &Connection,
    automation_id: &str,
) -> Result<Vec<RunInstructionsArtifact>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, instructions_path FROM automation_runs
             WHERE automation_id = ?1 AND instructions_path IS NOT NULL",
        )
        .map_err(|e| format!("Failed to prepare run instructions query: {}", e))?;
    let rows = stmt
        .query_map(params![automation_id], |row| {
            Ok(RunInstructionsArtifact {
                run_id: row.get(0)?,
                path: row.get(1)?,
            })
        })
        .map_err(|e| format!("Failed to query run instructions: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read run instructions: {}", e))
}

fn instruction_artifacts_for_worktree(
    conn: &Connection,
    worktree_path: &str,
) -> Result<Vec<RunInstructionsArtifact>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, instructions_path FROM automation_runs
             WHERE worktree_path = ?1 AND instructions_path IS NOT NULL",
        )
        .map_err(|e| format!("Failed to prepare run instructions query: {}", e))?;
    let rows = stmt
        .query_map(params![worktree_path], |row| {
            Ok(RunInstructionsArtifact {
                run_id: row.get(0)?,
                path: row.get(1)?,
            })
        })
        .map_err(|e| format!("Failed to query run instructions: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read run instructions: {}", e))
}

pub fn remove_instructions_for_worktree(
    conn: &Connection,
    worktree_path: &str,
) -> Result<(), String> {
    for artifact in instruction_artifacts_for_worktree(conn, worktree_path)? {
        match remove_run_instructions(&artifact.run_id, &artifact.path) {
            Ok(()) => {
                conn.execute(
                    "UPDATE automation_runs SET instructions_path = NULL WHERE id = ?1",
                    params![artifact.run_id],
                )
                .map_err(|e| format!("Failed to clear run instructions path: {}", e))?;
            }
            Err(error) => warn!(
                run_id = %artifact.run_id,
                instructions_path = %artifact.path,
                error = %error,
                "failed to clean up automation instructions"
            ),
        }
    }
    Ok(())
}

fn retry_orphaned_instruction_cleanup(conn: &Connection) -> Result<(), String> {
    let root = automation_run_storage_root()?;
    retry_orphaned_instruction_cleanup_at(conn, &root)
}

fn retry_orphaned_instruction_cleanup_at(conn: &Connection, root: &Path) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, worktree_path, instructions_path FROM automation_runs
             WHERE instructions_path IS NOT NULL
               AND worktree_path IS NOT NULL
               AND status IN ('completed', 'failed', 'aborted')",
        )
        .map_err(|e| format!("Failed to prepare orphaned instructions query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("Failed to query orphaned instructions: {}", e))?;
    let candidates = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read orphaned instructions: {}", e))?;

    for (run_id, worktree_path, instructions_path) in candidates {
        if Path::new(&worktree_path).exists() {
            continue;
        }
        match remove_run_instructions_at(root, &run_id, &instructions_path) {
            Ok(()) => {
                conn.execute(
                    "UPDATE automation_runs SET instructions_path = NULL WHERE id = ?1",
                    params![run_id],
                )
                .map_err(|e| format!("Failed to clear orphaned instructions path: {}", e))?;
            }
            Err(error) => warn!(
                run_id = %run_id,
                instructions_path = %instructions_path,
                error = %error,
                "orphaned automation instructions cleanup will retry at next startup"
            ),
        }
    }
    Ok(())
}

fn list_pending_run_events_at(
    conn: &Connection,
    instructions_root: &Path,
) -> Result<Vec<AutomationDueEvent>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, automation_id, instructions_path, automation_snapshot
             FROM automation_runs
             WHERE status = 'pending'
             ORDER BY created_at ASC, scheduled_for ASC",
        )
        .map_err(|e| format!("Failed to prepare pending automation runs query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| format!("Failed to query pending automation runs: {}", e))?;
    let pending = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read pending automation runs: {}", e))?;

    let mut events = Vec::new();
    for (run_id, automation_id, stored_path, stored_automation) in pending {
        let event = (|| -> Result<AutomationDueEvent, String> {
            let automation = match stored_automation {
                Some(snapshot) => serde_json::from_str::<Automation>(&snapshot)
                    .map_err(|e| format!("invalid run automation snapshot: {}", e))?,
                None => get_automation(conn, &automation_id)?,
            };
            let run = get_run(conn, &run_id)?;
            let instructions_path = match stored_path {
                Some(path) if Path::new(&path).is_file() => path,
                Some(path) => {
                    return Err(format!(
                        "immutable automation instructions are missing: {}",
                        path
                    ))
                }
                None => {
                    let path = ensure_run_instructions_at(instructions_root, &run, &automation)?;
                    set_run_dispatch_snapshot(conn, &run_id, &path, &automation)?;
                    path
                }
            };
            Ok(AutomationDueEvent {
                run_id: run_id.clone(),
                automation,
                instructions_path,
                worktree_path: run.worktree_path,
            })
        })();
        match event {
            Ok(event) => events.push(event),
            Err(error) => {
                report_run(conn, &run_id, None, "failed", Some(&error))?;
                warn!(
                    run_id = %run_id,
                    error = %error,
                    "failed to recover pending automation run"
                );
            }
        }
    }
    Ok(events)
}

pub fn list_pending_run_events(conn: &Connection) -> Result<Vec<AutomationDueEvent>, String> {
    let root = automation_run_storage_root()?;
    list_pending_run_events_at(conn, &root)
}

pub fn report_run(
    conn: &Connection,
    run_id: &str,
    worktree_path: Option<&str>,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    if !RUN_STATUSES.contains(&status) {
        return Err(format!("Invalid run status: {}", status));
    }
    let n = conn
        .execute(
            "UPDATE automation_runs SET worktree_path = COALESCE(?1, worktree_path), status = ?2, error = ?3 WHERE id = ?4",
            params![worktree_path, status, error, run_id],
        )
        .map_err(|e| format!("Failed to update run: {}", e))?;
    if n == 0 {
        return Err(format!("Run not found: {}", run_id));
    }
    Ok(())
}

pub(crate) fn assign_run_worktree(
    conn: &Connection,
    run_id: &str,
    worktree_path: &str,
) -> Result<String, String> {
    let run = get_run(conn, run_id)?;
    if let Some(existing) = run.worktree_path.as_deref() {
        if existing != worktree_path {
            return Err(format!(
                "run {} is already assigned to a different worktree",
                run_id
            ));
        }
    }
    let instructions_path = run
        .instructions_path
        .ok_or_else(|| format!("run {} has no automation instructions", run_id))?;
    conn.execute(
        "UPDATE automation_runs SET worktree_path = ?1 WHERE id = ?2",
        params![worktree_path, run_id],
    )
    .map_err(|e| format!("Failed to assign run worktree: {}", e))?;
    finalize_run_instructions(Path::new(&instructions_path), worktree_path)?;
    Ok(instructions_path)
}

/// Called once the hook server observes a stopped agent turn with no remaining
/// background tools: a launched automation run in this worktree is complete.
/// Returns the automation's name when a run was completed.
pub fn complete_run_for_worktree(
    conn: &Connection,
    worktree_path: &str,
) -> Result<Option<String>, String> {
    let name: Option<String> = conn
        .query_row(
            "SELECT a.name FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE r.worktree_path = ?1 AND r.status = 'launched'",
            params![worktree_path],
            |row| row.get(0),
        )
        .ok();
    if name.is_none() {
        return Ok(None);
    }
    conn.execute(
        "UPDATE automation_runs SET status = 'completed' WHERE worktree_path = ?1 AND status = 'launched'",
        params![worktree_path],
    )
    .map_err(|e| format!("Failed to complete run: {}", e))?;
    Ok(name)
}

/// A user interrupt is a failed automation outcome, not a successful Stop.
/// Returns the automation name when an active run was transitioned.
pub fn fail_run_for_worktree(
    conn: &Connection,
    worktree_path: &str,
    error: &str,
) -> Result<Option<String>, String> {
    let name: Option<String> = conn
        .query_row(
            "SELECT a.name FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE r.worktree_path = ?1 AND r.status = 'launched'",
            params![worktree_path],
            |row| row.get(0),
        )
        .ok();
    if name.is_none() {
        return Ok(None);
    }
    conn.execute(
        "UPDATE automation_runs
         SET status = 'failed', error = ?2
         WHERE worktree_path = ?1 AND status = 'launched'",
        params![worktree_path, error],
    )
    .map_err(|e| format!("Failed to fail interrupted run: {}", e))?;
    Ok(name)
}

/// Deleting a worktree aborts any in-flight run it carried. Finished runs
/// keep their status — reviewing the diff and then deleting the worktree is
/// the normal lifecycle. Marked seen: the deletion was deliberate, don't
/// badge it.
pub fn abort_runs_for_worktree(conn: &Connection, worktree_path: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "UPDATE automation_runs SET status = 'aborted', seen = 1
             WHERE worktree_path = ?1 AND status IN ('pending', 'launched')",
            params![worktree_path],
        )
        .map_err(|e| format!("Failed to abort runs: {}", e))?;
    Ok(n > 0)
}

/// Scratch repos of global automation runs, newest first, for the virtual
/// "Automations" project in the sidebar. `exists` is injected so tests
/// don't need real directories.
pub fn list_global_run_worktrees(
    conn: &Connection,
    exists: impl Fn(&str) -> bool,
) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT r.worktree_path, a.name FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE a.repo_path = '' AND r.worktree_path IS NOT NULL
             ORDER BY r.created_at DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to query run worktrees: {}", e))?;
    let mut seen_paths = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let (path, name) = row.map_err(|e| format!("Failed to read run worktree: {}", e))?;
        if seen_paths.insert(path.clone()) && exists(&path) {
            out.push((path, name));
        }
    }
    Ok(out)
}

/// Newest still-existing worktrees produced by any automation, regardless of
/// project scope. Used by the Automations sidebar as a review queue.
pub fn list_recent_run_worktrees(
    conn: &Connection,
    exists: impl Fn(&str) -> bool,
) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT r.worktree_path, COALESCE(w.title, a.name) FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             LEFT JOIN worktrees w ON w.path = r.worktree_path
             WHERE r.worktree_path IS NOT NULL
             ORDER BY r.created_at DESC, r.scheduled_for DESC
             LIMIT 200",
        )
        .map_err(|e| format!("Failed to prepare recent worktrees query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to query recent worktrees: {}", e))?;
    let mut seen_paths = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let (path, name) = row.map_err(|e| format!("Failed to read recent worktree: {}", e))?;
        if seen_paths.insert(path.clone()) && exists(&path) {
            out.push((path, name));
            if out.len() == 50 {
                break;
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize, PartialEq)]
pub struct UnseenRunCounts {
    pub total: i64,
    pub failed: i64,
}

/// Finished runs (completed/failed) the user hasn't looked at yet. Unscoped:
/// the Automations view shows every project (plus global), so the badge and
/// the seen watermark cover everything too.
pub fn count_unseen_runs(conn: &Connection) -> Result<UnseenRunCounts, String> {
    conn.query_row(
        "SELECT COUNT(*), SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)
         FROM automation_runs
         WHERE seen = 0 AND status IN ('completed', 'failed')",
        [],
        |row| {
            Ok(UnseenRunCounts {
                total: row.get(0)?,
                failed: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            })
        },
    )
    .map_err(|e| format!("Failed to count unseen runs: {}", e))
}

/// Mark finished runs seen. Only completed/failed rows — a launched run
/// marked seen mid-flight would never badge on completion.
pub fn mark_runs_seen(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "UPDATE automation_runs SET seen = 1
         WHERE seen = 0 AND status IN ('completed', 'failed')",
        [],
    )
    .map_err(|e| format!("Failed to mark runs seen: {}", e))
}

/// Create the scratch git repo a global automation run executes in. A real
/// repo (init + empty commit) so the main view's uncommitted diff shows
/// everything the agent wrote.
pub fn create_run_dir(name: &str) -> Result<String, String> {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() { "automation" } else { &slug };
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dir = dirs::home_dir()
        .ok_or("no home dir")?
        .join(".impala")
        .join("automation-runs")
        .join(format!("{}-{}", slug, stamp));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create run dir: {}", e))?;

    let git = |args: &[&str]| -> Result<(), String> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(args)
            .output()
            .map_err(|e| format!("git: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    };
    git(&["init"])?;
    // Identity flags so the empty commit works without global git config.
    git(&[
        "-c",
        "user.name=Impala",
        "-c",
        "user.email=impala@localhost",
        "commit",
        "--allow-empty",
        "-m",
        "Automation run start",
    ])?;
    Ok(dir.to_string_lossy().to_string())
}

pub fn list_runs_by_repo(conn: &Connection, repo_path: &str) -> Result<Vec<AutomationRun>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT r.{} FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE a.repo_path = ?1
             ORDER BY r.created_at DESC, r.scheduled_for DESC LIMIT 100",
            RUN_COLS.replace(", ", ", r.")
        ))
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    let rows = stmt
        .query_map(params![repo_path], row_to_run)
        .map_err(|e| format!("Failed to query runs: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read run: {}", e))
}

// --- dispatch + scheduler ---------------------------------------------------

pub(crate) fn dispatch(
    app: &AppHandle,
    conn: &Connection,
    automation: &Automation,
    scheduled_for: i64,
) -> Result<(), String> {
    let Some(run) = insert_run(conn, &automation.id, scheduled_for)? else {
        return Ok(());
    };
    let instructions_root = automation_run_storage_root()?;
    let instructions_path = ensure_run_instructions_at(&instructions_root, &run, automation)?;
    set_run_dispatch_snapshot(conn, &run.id, &instructions_path, automation)?;
    let _ = app.emit(
        "automation-due",
        AutomationDueEvent {
            run_id: run.id,
            automation: automation.clone(),
            instructions_path,
            worktree_path: None,
        },
    );
    let _ = app.emit("automation-runs-changed", ());
    Ok(())
}

pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // First tick fires immediately — that's the app-launch catch-up.
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            if let Err(e) = tick(&app) {
                warn!(error = %e, "automation scheduler tick failed");
            }
        }
    });
}

fn tick(app: &AppHandle) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    let state = app.state::<crate::DbState>();
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let due = due_automations(&conn, now)?;
    let mut changed = false;
    for automation in due {
        // The run covers the stored slot (possibly hours ago if the app was
        // closed); advancing strictly past `now` collapses any backlog to a
        // single catch-up run.
        let scheduled_for = automation.next_run_at;
        let next = match next_occurrence(&automation.schedule, now) {
            Ok(next) => next,
            Err(e) => {
                warn!(id = %automation.id, error = %e, "skipping automation with bad schedule");
                continue;
            }
        };
        set_next_run_at(&conn, &automation.id, next)?;
        changed = true;
        dispatch(app, &conn, &automation, scheduled_for)?;
    }
    if changed {
        let _ = app.emit("automations-changed", ());
    }
    Ok(())
}

// --- commands ---------------------------------------------------------------

#[tauri::command]
pub fn list_automations(
    state: tauri::State<'_, crate::DbState>,
) -> Result<Vec<Automation>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {AUTOMATION_COLS} FROM automations ORDER BY created_at ASC"
        ))
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    let rows = stmt
        .query_map([], row_to_automation)
        .map_err(|e| format!("Failed to query automations: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read automation: {}", e))
}

#[tauri::command]
pub fn create_automation(
    app: AppHandle,
    state: tauri::State<'_, crate::DbState>,
    automation: NewAutomation,
) -> Result<Automation, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let created = create_automation_row(&conn, automation, chrono::Utc::now().timestamp())?;
    let _ = app.emit("automations-changed", ());
    Ok(created)
}

#[tauri::command]
pub fn update_automation(
    app: AppHandle,
    state: tauri::State<'_, crate::DbState>,
    id: String,
    changes: UpdateAutomation,
) -> Result<Automation, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let updated = update_automation_row(&conn, &id, changes, chrono::Utc::now().timestamp())?;
    let _ = app.emit("automations-changed", ());
    Ok(updated)
}

#[tauri::command]
pub fn delete_automation(
    app: AppHandle,
    state: tauri::State<'_, crate::DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    delete_automation_row(&conn, &id)?;
    let _ = app.emit("automations-changed", ());
    let _ = app.emit("automation-runs-changed", ());
    Ok(())
}

#[tauri::command]
pub fn set_automation_enabled(
    app: AppHandle,
    state: tauri::State<'_, crate::DbState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    set_enabled_row(&conn, &id, enabled, chrono::Utc::now().timestamp())?;
    let _ = app.emit("automations-changed", ());
    Ok(())
}

#[tauri::command]
pub fn run_automation_now(
    app: AppHandle,
    state: tauri::State<'_, crate::DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let automation = get_automation(&conn, &id)?;
    // Deliberately does not touch next_run_at — an ad-hoc run leaves the
    // cadence alone.
    dispatch(&app, &conn, &automation, chrono::Utc::now().timestamp())
}

#[tauri::command]
pub fn list_automation_runs(
    state: tauri::State<'_, crate::DbState>,
) -> Result<Vec<AutomationRun>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RUN_COLS} FROM automation_runs
             ORDER BY created_at DESC, scheduled_for DESC LIMIT 200"
        ))
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    let rows = stmt
        .query_map([], row_to_run)
        .map_err(|e| format!("Failed to query runs: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read run: {}", e))
}

#[tauri::command]
pub fn list_pending_automation_runs(
    state: tauri::State<'_, crate::DbState>,
) -> Result<Vec<AutomationDueEvent>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    list_pending_run_events(&conn)
}

#[tauri::command]
pub fn report_automation_run(
    app: AppHandle,
    state: tauri::State<'_, crate::DbState>,
    run_id: String,
    worktree_path: Option<String>,
    status: String,
    error: Option<String>,
) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    report_run(
        &conn,
        &run_id,
        worktree_path.as_deref(),
        &status,
        error.as_deref(),
    )?;
    let _ = app.emit("automation-runs-changed", ());
    Ok(())
}

#[tauri::command]
pub fn finalize_automation_run_instructions(
    state: tauri::State<'_, crate::DbState>,
    run_id: String,
    worktree_path: String,
) -> Result<String, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    assign_run_worktree(&conn, &run_id, &worktree_path)
}

#[tauri::command]
pub fn prepare_automation_run_dir(
    state: tauri::State<'_, crate::DbState>,
    name: String,
    run_id: String,
) -> Result<String, String> {
    let path = create_run_dir(&name)?;
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    assign_run_worktree(&conn, &run_id, &path)?;
    Ok(path)
}

#[tauri::command]
pub fn list_automation_run_worktrees(
    state: tauri::State<'_, crate::DbState>,
) -> Result<Vec<crate::git::Worktree>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    Ok(
        list_global_run_worktrees(&conn, |p| std::path::Path::new(p).exists())?
            .into_iter()
            .map(|(path, name)| crate::git::Worktree {
                path,
                branch: "automation".to_string(),
                head_commit: String::new(),
                title: Some(name),
            })
            .collect(),
    )
}

#[tauri::command]
pub fn list_recent_automation_worktrees(
    state: tauri::State<'_, crate::DbState>,
) -> Result<Vec<crate::git::Worktree>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    Ok(
        list_recent_run_worktrees(&conn, |p| std::path::Path::new(p).exists())?
            .into_iter()
            .map(|(path, name)| crate::git::Worktree {
                path,
                branch: "automation".to_string(),
                head_commit: String::new(),
                title: Some(name),
            })
            .collect(),
    )
}

/// Delete a global run's scratch repo. Refuses anything outside
/// ~/.impala/automation-runs — this command removes directories wholesale.
#[tauri::command]
pub fn delete_automation_run_dir(
    app: AppHandle,
    state: tauri::State<'_, crate::DbState>,
    worktree_path: String,
) -> Result<(), String> {
    let runs_root = dirs::home_dir()
        .ok_or("no home dir")?
        .join(".impala")
        .join("automation-runs");
    let canonical =
        std::fs::canonicalize(&worktree_path).map_err(|e| format!("resolve run dir: {}", e))?;
    let canonical_root = std::fs::canonicalize(&runs_root)
        .map_err(|e| format!("resolve automation-runs dir: {}", e))?;
    if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
        return Err(format!(
            "refusing to delete {}: not an automation run dir",
            worktree_path
        ));
    }
    std::fs::remove_dir_all(&canonical).map_err(|e| format!("delete run dir: {}", e))?;

    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    remove_instructions_for_worktree(&conn, &worktree_path)?;
    if abort_runs_for_worktree(&conn, &worktree_path)? {
        let _ = app.emit("automation-runs-changed", ());
    }
    Ok(())
}

#[tauri::command]
pub fn count_unseen_automation_runs(
    state: tauri::State<'_, crate::DbState>,
) -> Result<UnseenRunCounts, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    count_unseen_runs(&conn)
}

#[tauri::command]
pub fn mark_automation_runs_seen(
    app: AppHandle,
    state: tauri::State<'_, crate::DbState>,
) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    // Emit only when something changed — the Automations view marks seen on
    // every refresh, and an unconditional emit would loop refresh → mark →
    // emit → refresh forever.
    if mark_runs_seen(&conn)? > 0 {
        let _ = app.emit("automation-runs-changed", ());
    }
    Ok(())
}

/// Validate a schedule and preview its next `count` occurrences (unix
/// seconds, local tz). Powers the schedule picker preview.
#[tauri::command]
pub fn cron_next_occurrences(schedule: String, count: usize) -> Result<Vec<i64>, String> {
    let sched = parse_schedule(&schedule)?;
    let now = chrono::Local::now();
    Ok(sched
        .after(&now)
        .take(count.min(10))
        .map(|dt| dt.timestamp())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        crate::worktrees::init_db(&conn).unwrap();
        conn
    }

    fn new_automation(schedule: &str) -> NewAutomation {
        NewAutomation {
            repo_path: "/repo".into(),
            name: "Daily digest".into(),
            prompt: "Summarize yesterday's commits".into(),
            agent: "claude".into(),
            schedule: schedule.into(),
        }
    }

    #[test]
    fn next_occurrence_is_strictly_future_and_within_cadence() {
        let now = chrono::Utc::now().timestamp();
        let next = next_occurrence("*/2 * * * *", now).unwrap();
        assert!(next > now);
        assert!(next - now <= 120);
    }

    #[test]
    fn schedule_validation_rejects_garbage() {
        assert!(next_occurrence("not cron", 0).is_err());
        assert!(next_occurrence("* * * * * *", 0).is_err()); // 6 fields
        assert!(next_occurrence("0 9 * * 1-5", chrono::Utc::now().timestamp()).is_ok());
    }

    #[test]
    fn schedule_accepts_named_weekdays_from_the_picker() {
        // The frontend presets emit named days; verify each shape parses and
        // that MON-FRI actually lands on a weekday.
        let now = chrono::Utc::now().timestamp();
        for schedule in ["0 * * * *", "0 9 * * *", "0 9 * * MON-FRI", "30 17 * * FRI"] {
            assert!(next_occurrence(schedule, now).is_ok(), "{schedule}");
        }
        let next = next_occurrence("0 9 * * MON-FRI", now).unwrap();
        let weekday = chrono::TimeZone::timestamp_opt(&chrono::Local, next, 0)
            .single()
            .unwrap()
            .format("%u")
            .to_string();
        let n: u32 = weekday.parse().unwrap();
        assert!((1..=5).contains(&n), "MON-FRI fired on ISO weekday {n}");
    }

    #[test]
    fn automation_crud_and_run_lifecycle() {
        let conn = test_conn();
        let now = chrono::Utc::now().timestamp();

        let created = create_automation_row(&conn, new_automation("0 9 * * 1-5"), now).unwrap();
        assert!(created.enabled);
        assert!(created.next_run_at > now);

        assert_eq!(list_by_repo(&conn, "/repo").unwrap().len(), 1);
        assert!(list_by_repo(&conn, "/other").unwrap().is_empty());

        // Invalid agent rejected
        assert!(create_automation_row(
            &conn,
            NewAutomation {
                agent: "cursor".into(),
                ..new_automation("0 9 * * *")
            },
            now
        )
        .is_err());

        // Update recomputes next_run_at
        let updated = update_automation_row(
            &conn,
            &created.id,
            UpdateAutomation {
                name: None,
                prompt: None,
                agent: None,
                schedule: Some("*/5 * * * *".into()),
                repo_path: None,
            },
            now,
        )
        .unwrap();
        assert!(updated.next_run_at - now <= 300);

        // Moving to another project re-scopes list queries
        update_automation_row(
            &conn,
            &created.id,
            UpdateAutomation {
                name: None,
                prompt: None,
                agent: None,
                schedule: None,
                repo_path: Some("/other".into()),
            },
            now,
        )
        .unwrap();
        assert!(list_by_repo(&conn, "/repo").unwrap().is_empty());
        assert_eq!(list_by_repo(&conn, "/other").unwrap().len(), 1);
        update_automation_row(
            &conn,
            &created.id,
            UpdateAutomation {
                name: None,
                prompt: None,
                agent: None,
                schedule: None,
                repo_path: Some("/repo".into()),
            },
            now,
        )
        .unwrap();

        // Run dedup on (automation_id, scheduled_for)
        let run = insert_run(&conn, &created.id, 1000).unwrap().unwrap();
        assert!(insert_run(&conn, &created.id, 1000).unwrap().is_none());

        // launched → completed via the worktree Stop path. A run marked seen
        // while still launched must re-badge on completion.
        report_run(&conn, &run.id, Some("/wt/auto-1"), "launched", None).unwrap();
        assert_eq!(mark_runs_seen(&conn).unwrap(), 0);
        assert_eq!(
            complete_run_for_worktree(&conn, "/wt/auto-1")
                .unwrap()
                .as_deref(),
            Some("Daily digest")
        );
        assert!(complete_run_for_worktree(&conn, "/wt/auto-1")
            .unwrap()
            .is_none());
        let runs = list_runs_by_repo(&conn, "/repo").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "completed");
        assert_eq!(runs[0].worktree_path.as_deref(), Some("/wt/auto-1"));

        // Unseen badge: one completed run, cleared by mark_runs_seen
        assert_eq!(
            count_unseen_runs(&conn).unwrap(),
            UnseenRunCounts {
                total: 1,
                failed: 0
            }
        );
        assert_eq!(mark_runs_seen(&conn).unwrap(), 1);
        assert_eq!(mark_runs_seen(&conn).unwrap(), 0);
        assert_eq!(
            count_unseen_runs(&conn).unwrap(),
            UnseenRunCounts {
                total: 0,
                failed: 0
            }
        );

        // Failed runs count as unseen too, flagged separately
        let run2 = insert_run(&conn, &created.id, 2000).unwrap().unwrap();
        report_run(&conn, &run2.id, None, "failed", Some("boom")).unwrap();
        assert_eq!(
            count_unseen_runs(&conn).unwrap(),
            UnseenRunCounts {
                total: 1,
                failed: 1
            }
        );

        // Global ("" scope) automations list under their own scope and their
        // runs land in the unscoped badge like any other.
        let global = create_automation_row(
            &conn,
            NewAutomation {
                repo_path: "".into(),
                ..new_automation("0 8 * * *")
            },
            now,
        )
        .unwrap();
        assert_eq!(list_by_repo(&conn, "").unwrap().len(), 1);
        assert_eq!(list_by_repo(&conn, "/repo").unwrap().len(), 1);
        let grun = insert_run(&conn, &global.id, 3000).unwrap().unwrap();
        report_run(&conn, &grun.id, Some("/scratch/g1"), "launched", None).unwrap();
        complete_run_for_worktree(&conn, "/scratch/g1").unwrap();
        assert_eq!(count_unseen_runs(&conn).unwrap().total, 2);
        assert_eq!(mark_runs_seen(&conn).unwrap(), 2);

        // Deleting a worktree aborts its in-flight run (already seen), but a
        // finished run's worktree deletion leaves the record alone.
        let run3 = insert_run(&conn, &created.id, 4000).unwrap().unwrap();
        report_run(&conn, &run3.id, Some("/wt/auto-2"), "launched", None).unwrap();
        assert!(abort_runs_for_worktree(&conn, "/wt/auto-2").unwrap());
        assert!(!abort_runs_for_worktree(&conn, "/wt/auto-2").unwrap());
        assert!(!abort_runs_for_worktree(&conn, "/scratch/g1").unwrap()); // completed stays
        let statuses: Vec<(String, String)> = list_runs_by_repo(&conn, "/repo")
            .unwrap()
            .into_iter()
            .map(|r| (r.id, r.status))
            .collect();
        assert!(statuses.contains(&(run3.id.clone(), "aborted".to_string())));
        assert_eq!(count_unseen_runs(&conn).unwrap().total, 0);
        // An aborted run can't complete later (stale Stop event after delete).
        assert!(!complete_run_for_worktree(&conn, "/wt/auto-2")
            .unwrap()
            .is_some());

        // Virtual-project listing: global run dirs that still exist, newest
        // first, deduped, project runs excluded.
        let grun2 = insert_run(&conn, &global.id, 5000).unwrap().unwrap();
        report_run(&conn, &grun2.id, Some("/scratch/g2"), "launched", None).unwrap();
        let listed = list_global_run_worktrees(&conn, |p| p != "/scratch/g2").unwrap();
        assert_eq!(
            listed,
            vec![("/scratch/g1".to_string(), "Daily digest".to_string())]
        );
        let listed_all = list_global_run_worktrees(&conn, |_| true).unwrap();
        assert_eq!(listed_all.len(), 2);
        assert_eq!(listed_all[0].0, "/scratch/g2"); // newest first
        crate::worktrees::upsert_title(&conn, "/scratch/g1", "Renamed run").unwrap();
        let recent = list_recent_run_worktrees(&conn, |p| p != "/wt/auto-2").unwrap();
        assert!(recent.iter().any(|(path, _)| path == "/scratch/g2"));
        assert!(recent
            .iter()
            .any(|(path, title)| path == "/scratch/g1" && title == "Renamed run"));
        assert!(recent.iter().any(|(path, _)| path == "/wt/auto-1"));
        assert!(!recent.iter().any(|(path, _)| path == "/wt/auto-2"));

        assert!(report_run(&conn, &run.id, None, "bogus", None).is_err());

        // Pause leaves next_run_at; resume recomputes from now
        set_enabled_row(&conn, &created.id, false, now).unwrap();
        assert!(!get_automation(&conn, &created.id).unwrap().enabled);
        set_enabled_row(&conn, &created.id, true, now).unwrap();
        assert!(get_automation(&conn, &created.id).unwrap().enabled);

        // Delete cascades runs
        delete_automation_row(&conn, &created.id).unwrap();
        assert!(list_by_repo(&conn, "/repo").unwrap().is_empty());
        assert!(list_runs_by_repo(&conn, "/repo").unwrap().is_empty());
    }

    #[test]
    fn interrupting_an_active_automation_marks_the_run_failed() {
        let conn = test_conn();
        let now = chrono::Utc::now().timestamp();
        let automation = create_automation_row(&conn, new_automation("0 9 * * *"), now).unwrap();
        let run = insert_run(&conn, &automation.id, now).unwrap().unwrap();
        report_run(&conn, &run.id, Some("/wt/interrupted"), "launched", None).unwrap();

        assert_eq!(
            fail_run_for_worktree(&conn, "/wt/interrupted", "Interrupted by user")
                .unwrap()
                .as_deref(),
            Some("Daily digest")
        );
        let interrupted = get_run(&conn, &run.id).unwrap();
        assert_eq!(interrupted.status, "failed");
        assert_eq!(interrupted.error.as_deref(), Some("Interrupted by user"));
    }

    #[test]
    fn due_query_and_advance() {
        let conn = test_conn();
        let now = chrono::Utc::now().timestamp();
        let a = create_automation_row(&conn, new_automation("0 9 * * *"), now).unwrap();

        // Nothing due while next_run_at is in the future
        assert!(due_automations(&conn, now).unwrap().is_empty());

        // Simulate a missed slot (app was closed)
        set_next_run_at(&conn, &a.id, now - 3600).unwrap();
        let due = due_automations(&conn, now).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].next_run_at, now - 3600);

        // Advancing past now empties the due set (catch-up-at-most-one)
        let next = next_occurrence(&a.schedule, now).unwrap();
        set_next_run_at(&conn, &a.id, next).unwrap();
        assert!(due_automations(&conn, now).unwrap().is_empty());

        // Disabled automations are never due
        set_next_run_at(&conn, &a.id, now - 60).unwrap();
        set_enabled_row(&conn, &a.id, false, now).unwrap();
        assert!(due_automations(&conn, now).unwrap().is_empty());
    }

    #[test]
    fn pending_run_events_can_be_recovered_after_startup() {
        let conn = test_conn();
        let now = chrono::Utc::now().timestamp();
        let automation = create_automation_row(&conn, new_automation("0 9 * * *"), now).unwrap();
        let run = insert_run(&conn, &automation.id, now - 600)
            .unwrap()
            .unwrap();
        let root = std::env::temp_dir().join(format!(
            "impala-automation-instructions-{}",
            uuid::Uuid::new_v4()
        ));

        let pending = list_pending_run_events_at(&conn, &root).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].run_id, run.id);
        assert_eq!(pending[0].automation.id, automation.id);
        assert!(pending[0].worktree_path.is_none());
        let instructions_path = PathBuf::from(&pending[0].instructions_path);
        assert_eq!(instructions_path, root.join(&run.id).join("AUTOMATION.md"));
        let markdown = std::fs::read_to_string(&instructions_path).unwrap();
        assert!(markdown.contains("# Automation Run"));
        assert!(markdown.contains(&format!("- Run ID: `{}`", run.id)));
        assert!(markdown.contains("## Instructions\n\nSummarize yesterday's commits"));
        assert!(std::fs::metadata(&instructions_path)
            .unwrap()
            .permissions()
            .readonly());

        // Recovery reuses the immutable snapshot even if the automation is
        // edited after the run was inserted.
        update_automation_row(
            &conn,
            &automation.id,
            UpdateAutomation {
                name: None,
                prompt: Some("A different prompt".into()),
                agent: None,
                schedule: None,
                repo_path: None,
            },
            now,
        )
        .unwrap();
        let recovered_again = list_pending_run_events_at(&conn, &root).unwrap();
        assert_eq!(
            recovered_again[0].instructions_path,
            pending[0].instructions_path
        );
        assert_eq!(
            recovered_again[0].automation.prompt,
            "Summarize yesterday's commits"
        );
        assert_eq!(recovered_again[0].automation.repo_path, "/repo");
        assert_eq!(recovered_again[0].automation.agent, "claude");
        assert_eq!(
            std::fs::read_to_string(&instructions_path).unwrap(),
            markdown
        );

        assign_run_worktree(&conn, &run.id, "/wt/recovered").unwrap();
        let finalized = std::fs::read_to_string(&instructions_path).unwrap();
        assert!(finalized.contains("- Worktree: `/wt/recovered`"));
        assert!(!finalized.contains(WORKTREE_CONTEXT_PLACEHOLDER));
        assert!(finalized.contains("Summarize yesterday's commits"));
        assert!(std::fs::metadata(&instructions_path)
            .unwrap()
            .permissions()
            .readonly());
        assert!(assign_run_worktree(&conn, &run.id, "/wt/different").is_err());

        let recovered_after_allocation = list_pending_run_events_at(&conn, &root).unwrap();
        assert_eq!(
            recovered_after_allocation[0].worktree_path.as_deref(),
            Some("/wt/recovered")
        );

        report_run(&conn, &run.id, None, "launched", None).unwrap();
        assert!(list_pending_run_events_at(&conn, &root).unwrap().is_empty());
        complete_run_for_worktree(&conn, "/wt/recovered").unwrap();
        retry_orphaned_instruction_cleanup_at(&conn, &root).unwrap();
        assert!(!instructions_path.exists());
        assert!(get_run(&conn, &run.id).unwrap().instructions_path.is_none());
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn missing_snapshot_is_not_recreated_from_edited_automation() {
        let conn = test_conn();
        let now = chrono::Utc::now().timestamp();
        let automation = create_automation_row(&conn, new_automation("0 9 * * *"), now).unwrap();
        let run = insert_run(&conn, &automation.id, now - 600)
            .unwrap()
            .unwrap();
        let root = std::env::temp_dir().join(format!(
            "impala-missing-automation-instructions-{}",
            uuid::Uuid::new_v4()
        ));
        let pending = list_pending_run_events_at(&conn, &root).unwrap();
        let instructions_path = PathBuf::from(&pending[0].instructions_path);
        remove_run_instructions_at(&root, &run.id, instructions_path.to_str().unwrap()).unwrap();

        update_automation_row(
            &conn,
            &automation.id,
            UpdateAutomation {
                name: None,
                prompt: Some("Replacement instructions".into()),
                agent: None,
                schedule: None,
                repo_path: None,
            },
            now,
        )
        .unwrap();
        let healthy = create_automation_row(
            &conn,
            NewAutomation {
                name: "Healthy automation".into(),
                ..new_automation("0 10 * * *")
            },
            now,
        )
        .unwrap();
        let healthy_run = insert_run(&conn, &healthy.id, now - 300).unwrap().unwrap();
        let recovered = list_pending_run_events_at(&conn, &root).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].run_id, healthy_run.id);
        let failed = get_run(&conn, &run.id).unwrap();
        assert_eq!(failed.status, "failed");
        assert!(failed
            .error
            .as_deref()
            .unwrap()
            .contains("immutable automation instructions are missing"));
        assert!(!instructions_path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
