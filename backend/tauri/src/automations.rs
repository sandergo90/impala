use std::str::FromStr;

use chrono::TimeZone;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Automation {
    pub id: String,
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
}

#[derive(Debug, Serialize, Clone)]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    /// Unix seconds of the slot this run covers (the automation's
    /// next_run_at at fire time — may be in the past for a catch-up run).
    pub scheduled_for: i64,
    pub worktree_path: Option<String>,
    /// pending → launched → completed | failed. skipped reserved.
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Serialize)]
pub struct AutomationDueEvent {
    pub run_id: String,
    pub automation: Automation,
}

const RUN_STATUSES: &[&str] = &["pending", "launched", "completed", "failed", "skipped"];

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
        status: row.get(4)?,
        error: row.get(5)?,
        created_at: row.get(6)?,
    })
}

const RUN_COLS: &str = "id, automation_id, scheduled_for, worktree_path, status, error, created_at";

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
    // Recompute unconditionally: cheap, and correct whether or not the
    // schedule changed (an unchanged schedule recomputes to the same slot).
    let next_run_at = next_occurrence(&schedule, now)?;
    let ts = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE automations SET name = ?1, prompt = ?2, agent = ?3, schedule = ?4, next_run_at = ?5, updated_at = ?6 WHERE id = ?7",
        params![name, prompt, agent, schedule, next_run_at, ts, id],
    )
    .map_err(|e| format!("Failed to update automation: {}", e))?;
    get_automation(conn, id)
}

pub fn delete_automation_row(conn: &Connection, id: &str) -> Result<(), String> {
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

pub fn set_enabled_row(
    conn: &Connection,
    id: &str,
    enabled: bool,
    now: i64,
) -> Result<(), String> {
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
        status: "pending".to_string(),
        error: None,
        created_at: ts,
    }))
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

/// Called from the hook server on the agent's Stop event: the agent in this
/// worktree finished a turn — a launched automation run there is complete.
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

#[derive(Debug, Serialize, PartialEq)]
pub struct UnseenRunCounts {
    pub total: i64,
    pub failed: i64,
}

/// Finished runs (completed/failed) the user hasn't looked at yet.
pub fn count_unseen_runs(conn: &Connection, repo_path: &str) -> Result<UnseenRunCounts, String> {
    conn.query_row(
        "SELECT COUNT(*), SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END)
         FROM automation_runs r JOIN automations a ON a.id = r.automation_id
         WHERE a.repo_path = ?1 AND r.seen = 0 AND r.status IN ('completed', 'failed')",
        params![repo_path],
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
pub fn mark_runs_seen(conn: &Connection, repo_path: &str) -> Result<usize, String> {
    conn.execute(
        "UPDATE automation_runs SET seen = 1
         WHERE seen = 0 AND status IN ('completed', 'failed')
           AND automation_id IN (SELECT id FROM automations WHERE repo_path = ?1)",
        params![repo_path],
    )
    .map_err(|e| format!("Failed to mark runs seen: {}", e))
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

fn dispatch(
    app: &AppHandle,
    conn: &Connection,
    automation: &Automation,
    scheduled_for: i64,
) -> Result<(), String> {
    let Some(run) = insert_run(conn, &automation.id, scheduled_for)? else {
        return Ok(());
    };
    let _ = app.emit(
        "automation-due",
        AutomationDueEvent {
            run_id: run.id,
            automation: automation.clone(),
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
    repo: String,
) -> Result<Vec<Automation>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    list_by_repo(&conn, &repo)
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
    repo: String,
) -> Result<Vec<AutomationRun>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    list_runs_by_repo(&conn, &repo)
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
pub fn count_unseen_automation_runs(
    state: tauri::State<'_, crate::DbState>,
    repo: String,
) -> Result<UnseenRunCounts, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    count_unseen_runs(&conn, &repo)
}

#[tauri::command]
pub fn mark_automation_runs_seen(
    app: AppHandle,
    state: tauri::State<'_, crate::DbState>,
    repo: String,
) -> Result<(), String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    // Emit only when something changed — the Automations view marks seen on
    // every refresh, and an unconditional emit would loop refresh → mark →
    // emit → refresh forever.
    if mark_runs_seen(&conn, &repo)? > 0 {
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
            },
            now,
        )
        .unwrap();
        assert!(updated.next_run_at - now <= 300);

        // Run dedup on (automation_id, scheduled_for)
        let run = insert_run(&conn, &created.id, 1000).unwrap().unwrap();
        assert!(insert_run(&conn, &created.id, 1000).unwrap().is_none());

        // launched → completed via the worktree Stop path. A run marked seen
        // while still launched must re-badge on completion.
        report_run(&conn, &run.id, Some("/wt/auto-1"), "launched", None).unwrap();
        assert_eq!(mark_runs_seen(&conn, "/repo").unwrap(), 0);
        assert_eq!(
            complete_run_for_worktree(&conn, "/wt/auto-1").unwrap().as_deref(),
            Some("Daily digest")
        );
        assert!(complete_run_for_worktree(&conn, "/wt/auto-1").unwrap().is_none());
        let runs = list_runs_by_repo(&conn, "/repo").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "completed");
        assert_eq!(runs[0].worktree_path.as_deref(), Some("/wt/auto-1"));

        // Unseen badge: one completed run, cleared by mark_runs_seen
        assert_eq!(
            count_unseen_runs(&conn, "/repo").unwrap(),
            UnseenRunCounts { total: 1, failed: 0 }
        );
        assert_eq!(mark_runs_seen(&conn, "/repo").unwrap(), 1);
        assert_eq!(mark_runs_seen(&conn, "/repo").unwrap(), 0);
        assert_eq!(
            count_unseen_runs(&conn, "/repo").unwrap(),
            UnseenRunCounts { total: 0, failed: 0 }
        );

        // Failed runs count as unseen too, flagged separately
        let run2 = insert_run(&conn, &created.id, 2000).unwrap().unwrap();
        report_run(&conn, &run2.id, None, "failed", Some("boom")).unwrap();
        assert_eq!(
            count_unseen_runs(&conn, "/repo").unwrap(),
            UnseenRunCounts { total: 1, failed: 1 }
        );

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
}
