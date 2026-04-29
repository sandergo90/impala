mod agent_config;
mod annotations;
mod config;
mod daemon_client;
mod fonts;
mod git;
mod github;
mod hook_server;
mod hotkeys;
mod linear;
mod linear_context;
mod notifications;
mod observability;
mod plan_annotations;
mod plan_scanner;
mod plans;
mod pty;
mod settings;
mod viewed_files;
mod watcher;
mod worktree_issues;
mod worktrees;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

pub(crate) struct DbState(pub(crate) Mutex<rusqlite::Connection>);
struct DiffCache(Mutex<lru::LruCache<String, String>>);
struct HookPort(u16);

fn default_worktree_base_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".impala")
        .join("worktrees")
}

fn sanitize_prefix(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

fn resolve_branch_prefix(mode: &str, custom: &str) -> String {
    match mode {
        "author" => git::get_git_user_name().map(|n| sanitize_prefix(&n)).unwrap_or_default(),
        "custom" => custom.to_string(),
        _ => String::new(),
    }
}

#[tauri::command]
async fn check_git() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("git")
            .arg("--version")
            .output()
            .map_err(|_| "Git is not installed. Please install Git to use Impala.".to_string())?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err("Git is not installed. Please install Git to use Impala.".to_string())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn load_projects(state: tauri::State<'_, DbState>) -> Result<Vec<String>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    settings::load_projects(&conn)
}

#[tauri::command]
fn save_projects(state: tauri::State<'_, DbState>, projects: Vec<String>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    settings::save_projects(&conn, &projects)
}

#[tauri::command]
async fn list_worktrees(
    state: tauri::State<'_, DbState>,
    repo_path: String,
) -> Result<Vec<git::Worktree>, String> {
    let mut worktrees = tokio::task::spawn_blocking(move || git::list_worktrees(&repo_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))??;

    let titles = {
        let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
        worktrees::get_all_titles(&conn)?
    };
    for wt in worktrees.iter_mut() {
        if worktrees::is_main_branch(&wt.branch) {
            wt.title = None;
            continue;
        }
        wt.title = Some(
            titles
                .get(&wt.path)
                .cloned()
                .unwrap_or_else(|| worktrees::default_title_from_branch(&wt.branch)),
        );
    }
    Ok(worktrees)
}

#[tauri::command]
async fn detect_base_branch(worktree_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::detect_base_branch(&worktree_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_diverged_commits(
    worktree_path: String,
    base_branch: Option<String>,
) -> Result<Vec<git::CommitInfo>, String> {
    tokio::task::spawn_blocking(move || git::get_diverged_commits(&worktree_path, base_branch))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_changed_files(
    worktree_path: String,
    commit_hash: String,
) -> Result<Vec<git::ChangedFile>, String> {
    tokio::task::spawn_blocking(move || git::get_changed_files(&worktree_path, &commit_hash))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_commit_diff(
    worktree_path: String,
    commit_hash: String,
    file_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::get_commit_diff(&worktree_path, &commit_hash, &file_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_full_commit_diff(
    cache: tauri::State<'_, DiffCache>,
    worktree_path: String,
    commit_hash: String,
) -> Result<String, String> {
    let key = format!("commit:{}:{}", worktree_path, commit_hash);
    {
        let mut c = cache.0.lock().map_err(|e| format!("Cache lock error: {}", e))?;
        if let Some(cached) = c.get(&key) {
            return Ok(cached.clone());
        }
    }
    let result = tokio::task::spawn_blocking(move || git::get_full_commit_diff(&worktree_path, &commit_hash))
        .await
        .map_err(|e| format!("Task join error: {}", e))??;
    {
        let mut c = cache.0.lock().map_err(|e| format!("Cache lock error: {}", e))?;
        c.put(key, result.clone());
    }
    Ok(result)
}

#[tauri::command]
async fn get_file_at_ref(
    worktree_path: String,
    git_ref: String,
    file_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::get_file_at_ref(&worktree_path, &git_ref, &file_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_branch_diff(worktree_path: String, file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::get_branch_diff(&worktree_path, &file_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_uncommitted_files(worktree_path: String) -> Result<Vec<git::ChangedFile>, String> {
    tokio::task::spawn_blocking(move || git::get_uncommitted_files(&worktree_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_uncommitted_diff(worktree_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::get_uncommitted_diff(&worktree_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn discard_file_changes(worktree_path: String, file_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || git::discard_file_changes(&worktree_path, &file_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_full_branch_diff(
    cache: tauri::State<'_, DiffCache>,
    worktree_path: String,
) -> Result<String, String> {
    let key = format!("branch:{}", worktree_path);
    {
        let mut c = cache.0.lock().map_err(|e| format!("Cache lock error: {}", e))?;
        if let Some(cached) = c.get(&key) {
            return Ok(cached.clone());
        }
    }
    let result = tokio::task::spawn_blocking(move || git::get_full_branch_diff(&worktree_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))??;
    {
        let mut c = cache.0.lock().map_err(|e| format!("Cache lock error: {}", e))?;
        c.put(key, result.clone());
    }
    Ok(result)
}

#[tauri::command]
fn invalidate_branch_cache(
    cache: tauri::State<'_, DiffCache>,
    worktree_path: String,
) -> Result<(), String> {
    let mut c = cache.0.lock().map_err(|e| format!("Cache lock error: {}", e))?;
    let key = format!("branch:{}", worktree_path);
    c.pop(&key);
    Ok(())
}

#[tauri::command]
async fn get_head_commit(worktree_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::get_head_commit(&worktree_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_all_changed_files(worktree_path: String) -> Result<Vec<git::ChangedFile>, String> {
    tokio::task::spawn_blocking(move || git::get_all_changed_files(&worktree_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn create_worktree(
    state: tauri::State<'_, DbState>,
    repo_path: String,
    branch_name: String,
    base_branch: Option<String>,
    existing: bool,
    initial_title: Option<String>,
) -> Result<git::Worktree, String> {
    let (prefix_mode, prefix_custom, worktree_base_dir) = {
        let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
        (
            settings::get_setting(&conn, "branchPrefixMode", "global")?.unwrap_or_default(),
            settings::get_setting(&conn, "branchPrefixCustom", "global")?.unwrap_or_default(),
            settings::get_setting(&conn, "worktreeBaseDir", "global")?,
        )
    };

    let repo_for_task = repo_path.clone();
    let branch_for_task = branch_name.clone();
    let mut worktree = tokio::task::spawn_blocking(move || {
        let prefix = resolve_branch_prefix(&prefix_mode, &prefix_custom);
        let final_branch = if !existing && !prefix.is_empty() {
            format!("{}/{}", prefix, branch_for_task)
        } else {
            branch_for_task
        };

        let base_dir = worktree_base_dir
            .map(PathBuf::from)
            .unwrap_or_else(default_worktree_base_dir);
        let project_name = Path::new(&repo_for_task)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");
        let wt_path = base_dir.join(project_name).join(&final_branch);

        git::create_worktree(
            &repo_for_task,
            &final_branch,
            base_branch,
            existing,
            &wt_path.to_string_lossy(),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    if !worktrees::is_main_branch(&worktree.branch) {
        let title = match initial_title {
            Some(t) if !t.trim().is_empty() => t.trim().to_string(),
            _ => worktrees::default_title_from_branch(&branch_name),
        };
        let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
        worktrees::upsert_title(&conn, &worktree.path, &title)?;
        worktree.title = Some(title);
    }

    Ok(worktree)
}

#[tauri::command]
async fn delete_worktree(
    state: tauri::State<'_, DbState>,
    repo_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    let delete_branch = {
        let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
        settings::get_setting(&conn, "deleteLocalBranch", "global")?
            .map(|v| v == "true")
            .unwrap_or(true)
    };

    tokio::task::spawn_blocking(move || {
        git::delete_worktree(&repo_path, &worktree_path, force, delete_branch)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn list_branches(repo_path: String) -> Result<Vec<git::BranchInfo>, String> {
    tokio::task::spawn_blocking(move || git::list_branches(&repo_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn fetch_remote(repo_path: String, remote: Option<String>) -> Result<(), String> {
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    tokio::task::spawn_blocking(move || git::fetch_remote(&repo_path, &remote))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn create_annotation(
    state: tauri::State<'_, DbState>,
    annotation: annotations::NewAnnotation,
) -> Result<annotations::Annotation, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    annotations::create_annotation(&conn, annotation)
}

#[tauri::command]
fn list_annotations(
    state: tauri::State<'_, DbState>,
    repo: String,
    file: Option<String>,
    commit: Option<String>,
) -> Result<Vec<annotations::Annotation>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    annotations::list_annotations(&conn, &repo, file.as_deref(), commit.as_deref())
}

#[tauri::command]
fn update_annotation(
    state: tauri::State<'_, DbState>,
    id: String,
    changes: annotations::UpdateAnnotation,
) -> Result<annotations::Annotation, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    annotations::update_annotation(&conn, &id, changes)
}

#[tauri::command]
fn delete_annotation(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    annotations::delete_annotation(&conn, &id)
}

#[tauri::command]
fn create_plan(
    state: tauri::State<'_, DbState>,
    plan: plans::NewPlan,
) -> Result<plans::Plan, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    plans::create_plan(&conn, plan)
}

#[tauri::command]
fn list_plans(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
) -> Result<Vec<plans::Plan>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    plans::list_plans(&conn, &worktree_path)
}

#[tauri::command]
fn get_plan(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<plans::Plan, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    plans::get_plan(&conn, &id)
}

#[tauri::command]
fn list_plan_version_files(
    state: tauri::State<'_, DbState>,
    plan_id: String,
) -> Result<Vec<plans::PlanFile>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    plans::list_plan_version_files(&conn, &plan_id)
}

#[tauri::command]
fn update_plan(
    state: tauri::State<'_, DbState>,
    id: String,
    changes: plans::UpdatePlan,
) -> Result<plans::Plan, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    let updated = plans::update_plan(&conn, &id, changes)?;

    if updated.status != "pending" {
        let signal_path = format!("/tmp/impala-plan-{}.decided", id);
        let _ = std::fs::write(&signal_path, &updated.status);
    }

    Ok(updated)
}

#[tauri::command]
fn create_plan_annotation(
    state: tauri::State<'_, DbState>,
    annotation: plan_annotations::NewPlanAnnotation,
) -> Result<plan_annotations::PlanAnnotation, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    plan_annotations::create_plan_annotation(&conn, annotation)
}

#[tauri::command]
fn list_plan_annotations(
    state: tauri::State<'_, DbState>,
    plan_path: String,
    worktree_path: Option<String>,
) -> Result<Vec<plan_annotations::PlanAnnotation>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    plan_annotations::list_plan_annotations(&conn, &plan_path, worktree_path.as_deref())
}

#[tauri::command]
fn update_plan_annotation(
    state: tauri::State<'_, DbState>,
    id: String,
    changes: plan_annotations::UpdatePlanAnnotation,
) -> Result<plan_annotations::PlanAnnotation, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    plan_annotations::update_plan_annotation(&conn, &id, changes)
}

#[tauri::command]
fn delete_plan_annotation(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    plan_annotations::delete_plan_annotation(&conn, &id)
}

#[tauri::command]
async fn read_plan_file(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        // If path is a directory, try overview.md inside it
        let file_path = if p.is_dir() {
            p.join("overview.md")
        } else {
            p.to_path_buf()
        };
        std::fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read {}: {}", file_path.display(), e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn list_plan_files(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        // Resolve to directory: if path is a file, use its parent
        let dir = if p.is_dir() {
            p.to_path_buf()
        } else if let Some(parent) = p.parent() {
            if parent.is_dir() { parent.to_path_buf() } else { return Ok(vec![]); }
        } else {
            return Ok(vec![]);
        };

        // Only show file tabs for plan directories (those containing overview.md)
        if !dir.join("overview.md").exists() {
            return Ok(vec![]);
        }

        let mut files: Vec<String> = std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read directory: {}", e))?
            .flatten()
            .filter(|e| {
                e.path().extension().is_some_and(|ext| ext == "md") && e.path().is_file()
            })
            .map(|e| e.path().to_string_lossy().to_string())
            .collect();

        // Sort: overview.md first, then task-N.md in order, then rest
        files.sort_by(|a, b| {
            let a_name = std::path::Path::new(a).file_name().unwrap_or_default().to_string_lossy();
            let b_name = std::path::Path::new(b).file_name().unwrap_or_default().to_string_lossy();
            let rank = |name: &str| -> u32 {
                if name == "overview.md" { 0 }
                else if name.starts_with("task-") { 1 }
                else { 2 }
            };
            let ra = rank(&a_name);
            let rb = rank(&b_name);
            if ra != rb { ra.cmp(&rb) } else { a_name.cmp(&b_name) }
        });

        Ok(files)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn set_file_viewed(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    view_kind: String,
    commit_hash: Option<String>,
    file_path: String,
) -> Result<(), String> {
    let view = viewed_files::ViewKind::from_parts(&view_kind, commit_hash.as_deref())?;
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::set_viewed(&conn, &worktree_path, view, &file_path)
}

#[tauri::command]
async fn get_file_diff_since_commit(
    worktree_path: String,
    since_commit: String,
    file_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || git::get_file_diff_since_commit(&worktree_path, &since_commit, &file_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn unset_file_viewed(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    file_path: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::unset_viewed(&conn, &worktree_path, &file_path)
}

#[tauri::command]
fn set_files_viewed(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    view_kind: String,
    commit_hash: Option<String>,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let view = viewed_files::ViewKind::from_parts(&view_kind, commit_hash.as_deref())?;
    let mut conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::set_many_viewed(&mut conn, &worktree_path, view, &file_paths)
}

#[tauri::command]
fn unset_files_viewed(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::unset_many_viewed(&mut conn, &worktree_path, &file_paths)
}

#[tauri::command]
fn check_viewed_files(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    view_kind: String,
    commit_hash: Option<String>,
    file_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let view = viewed_files::ViewKind::from_parts(&view_kind, commit_hash.as_deref())?;
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::check_viewed(&conn, &worktree_path, view, &file_paths)
}

#[tauri::command]
fn clear_viewed_files(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::clear_for_worktree(&conn, &worktree_path)
}

#[tauri::command]
async fn prepare_agent_config(
    worktree_path: String,
    agent: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    let path = std::path::PathBuf::from(&worktree_path);
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let mcp_binary = which_mcp_binary(&home)?;

    let env = tokio::task::spawn_blocking(move || -> Result<std::collections::HashMap<String, String>, String> {
        let mut env = std::collections::HashMap::new();
        match agent.as_str() {
            "claude" => {
                setup_claude_integration_sync()?;
                agent_config::write_claude_config(&path)?;
            }
            "codex" => {
                let codex_home = agent_config::write_codex_config(&path, &mcp_binary)?;
                env.insert(
                    "CODEX_HOME".to_string(),
                    codex_home.to_string_lossy().to_string(),
                );
            }
            other => return Err(format!("unknown agent: {}", other)),
        }
        Ok(env)
    })
    .await
    .map_err(|e| format!("task join: {}", e))??;

    Ok(env)
}

fn setup_claude_integration_sync() -> Result<String, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    let mcp_binary = which_mcp_binary(&home)?;

    let settings_path = home.join(".claude.json");
    let mut settings: serde_json::Value = if settings_path.exists() {
        let contents = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&contents).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let mcp_servers = settings
        .as_object_mut()
        .ok_or_else(|| "Settings is not a JSON object".to_string())?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));

    mcp_servers
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not a JSON object".to_string())?
        .insert("impala".to_string(), serde_json::json!({
            "command": mcp_binary,
            "args": []
        }));

    let formatted = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, formatted)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(mcp_binary)
}

fn which_mcp_binary(home: &std::path::Path) -> Result<String, String> {
    // Bundled sidecar lives next to the main executable (Tauri externalBin).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join("impala-mcp");
            if sidecar.exists() {
                return Ok(sidecar.to_string_lossy().to_string());
            }
        }
    }

    if let Ok(output) = std::process::Command::new("which").arg("impala-mcp").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }

    let cargo_bin = home.join(".cargo").join("bin").join("impala-mcp");
    if cargo_bin.exists() {
        return Ok(cargo_bin.to_string_lossy().to_string());
    }

    Err("impala-mcp binary not found".to_string())
}

#[tauri::command]
async fn open_in_editor(
    editor: String,
    path: String,
    line: Option<u32>,
    col: Option<u32>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let app_name = match editor.as_str() {
            "cursor" => "Cursor",
            "vscode" => "Visual Studio Code",
            "zed" => "Zed",
            "webstorm" => "WebStorm",
            "sublime" => "Sublime Text",
            _ => return Err(format!("Unknown editor: {}", editor)),
        };

        let output = if let Some(ln) = line {
            let col = col.unwrap_or(1);
            match editor.as_str() {
                "cursor" | "vscode" => {
                    let cli = if editor == "cursor" { "cursor" } else { "code" };
                    std::process::Command::new(cli)
                        .arg("--goto")
                        .arg(format!("{}:{}:{}", path, ln, col))
                        .output()
                        .map_err(|e| format!("Failed to launch {}: {}", app_name, e))?
                }
                "zed" => {
                    std::process::Command::new("zed")
                        .arg(format!("{}:{}:{}", path, ln, col))
                        .output()
                        .map_err(|e| format!("Failed to launch Zed: {}", e))?
                }
                "sublime" => {
                    std::process::Command::new("subl")
                        .arg(format!("{}:{}:{}", path, ln, col))
                        .output()
                        .map_err(|e| format!("Failed to launch Sublime Text: {}", e))?
                }
                "webstorm" => {
                    std::process::Command::new("open")
                        .arg("-a")
                        .arg(app_name)
                        .arg("--args")
                        .arg("--line")
                        .arg(ln.to_string())
                        .arg("--column")
                        .arg(col.to_string())
                        .arg(&path)
                        .output()
                        .map_err(|e| format!("Failed to launch WebStorm: {}", e))?
                }
                _ => unreachable!(),
            }
        } else {
            std::process::Command::new("open")
                .arg("-a")
                .arg(app_name)
                .arg(&path)
                .output()
                .map_err(|e| format!("Failed to launch {}: {}", app_name, e))?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to open {}: {}", app_name, stderr.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn resolve_file_path(base_dir: String, candidate: String) -> Result<(String, bool), String> {
    let candidate = candidate.trim();

    let abs = if candidate.starts_with('/') {
        std::path::PathBuf::from(candidate)
    } else if candidate.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(&candidate[2..])
        } else {
            std::path::Path::new(&base_dir).join(candidate)
        }
    } else {
        let clean = candidate.strip_prefix("./").unwrap_or(candidate);
        std::path::Path::new(&base_dir).join(clean)
    };

    let exists = abs.exists();
    Ok((abs.to_string_lossy().to_string(), exists))
}

#[tauri::command]
fn get_hook_port(state: tauri::State<'_, HookPort>) -> u16 {
    state.0
}

#[tauri::command]
fn get_agent_statuses(state: tauri::State<'_, Arc<hook_server::AgentStatuses>>) -> HashMap<String, String> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
async fn check_generated_files(worktree_path: String, files: Vec<String>) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || git::check_generated_files(&worktree_path, &files))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_my_linear_issues(api_key: String) -> Result<Vec<linear::LinearIssue>, String> {
    tokio::task::spawn_blocking(move || linear::get_my_issues(&api_key))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn search_linear_issues(api_key: String, query: String) -> Result<Vec<linear::LinearIssue>, String> {
    tokio::task::spawn_blocking(move || linear::search_issues(&api_key, &query))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn start_linear_issue(api_key: String, issue_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || linear::start_issue(&api_key, &issue_id))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn link_worktree_issue(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    issue_id: String,
    identifier: String,
) -> Result<worktree_issues::WorktreeIssue, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    worktree_issues::link_worktree(&conn, &worktree_path, &issue_id, &identifier)
}

#[tauri::command]
fn get_worktree_issue(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
) -> Result<Option<worktree_issues::WorktreeIssue>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    worktree_issues::get_issue_for_worktree(&conn, &worktree_path)
}

#[tauri::command]
fn get_all_worktree_issues(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<worktree_issues::WorktreeIssue>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    worktree_issues::get_all_worktree_issues(&conn)
}

#[tauri::command]
fn unlink_worktree_issue(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    worktree_issues::unlink_worktree(&conn, &worktree_path)
}

#[tauri::command]
fn rename_worktree_title(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    title: String,
) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    worktrees::upsert_title(&conn, &worktree_path, trimmed)
}

#[tauri::command]
fn unlink_worktree_title(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    worktrees::delete_row(&conn, &worktree_path)
}

#[tauri::command]
fn get_pr_status(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
) -> Result<Option<github::PrStatus>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    github::read_status(&conn, &worktree_path)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PrStatusUpdated {
    worktree_path: String,
    status: github::PrStatus,
}

#[tauri::command]
async fn refresh_pr_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    worktree_path: String,
) -> Result<(), String> {
    let wt_for_task = worktree_path.clone();
    let fetched = tokio::task::spawn_blocking(move || github::fetch_pr_status(&wt_for_task))
        .await
        .map_err(|e| format!("Task join error: {}", e))?;

    // Silent failure: leave the cached row as-is.
    let Ok(status) = fetched else { return Ok(()) };

    {
        let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
        // Skip emit when the status hasn't changed — stops the 60s poll
        // from re-rendering the sidebar for every worktree every minute.
        if github::read_status(&conn, &worktree_path)?.as_ref() == Some(&status) {
            return Ok(());
        }
        github::upsert_status(&conn, &worktree_path, &status)?;
    }

    let _ = app.emit(
        "pr-status-updated",
        PrStatusUpdated {
            worktree_path,
            status,
        },
    );
    Ok(())
}

#[tauri::command]
fn delete_pr_status(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    github::delete_status(&conn, &worktree_path)
}

#[tauri::command]
async fn get_github_cli_status() -> Result<github::GithubCliStatus, String> {
    tokio::task::spawn_blocking(|| {
        github::invalidate_cli_status_cache();
        github::cli_status()
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))
}

#[tauri::command]
fn get_setting(
    state: tauri::State<'_, DbState>,
    key: String,
    scope: String,
) -> Result<Option<String>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    settings::get_setting(&conn, &key, &scope)
}

#[tauri::command]
fn set_setting(
    state: tauri::State<'_, DbState>,
    key: String,
    scope: String,
    value: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    settings::set_setting(&conn, &key, &scope, &value)
}

#[tauri::command]
fn delete_setting(
    state: tauri::State<'_, DbState>,
    key: String,
    scope: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    settings::delete_setting(&conn, &key, &scope)
}

#[derive(serde::Serialize)]
struct GitInfo {
    author_name: Option<String>,
}

#[tauri::command]
async fn get_git_info() -> Result<GitInfo, String> {
    tokio::task::spawn_blocking(|| {
        Ok(GitInfo {
            author_name: git::get_git_user_name(),
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn get_default_worktree_base_dir() -> String {
    default_worktree_base_dir().to_string_lossy().to_string()
}

#[tauri::command]
async fn write_linear_context(api_key: String, issue_id: String, worktree_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || linear_context::write_context(&api_key, &issue_id, &worktree_path, true))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn refresh_linear_context(api_key: String, issue_id: String, worktree_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || linear_context::write_context(&api_key, &issue_id, &worktree_path, false))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn clean_linear_context(worktree_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || linear_context::clean_context(&worktree_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Exact paths to check first (top-level, highest priority).
const FAVICON_EXACT: &[&str] = &[
    "favicon.ico",
    "favicon.png",
    "favicon.svg",
    "logo.png",
    "logo.svg",
    "icon.png",
    "icon.svg",
    ".github/logo.png",
    ".github/logo.svg",
];

/// Glob patterns for deeper searches (monorepos, nested public dirs).
/// Searched in order; first match wins.
const FAVICON_GLOBS: &[&str] = &[
    "**/public/favicon.ico",
    "**/public/favicon.png",
    "**/public/favicon.svg",
    "**/public/icons/favicon.ico",
    "**/public/icons/favicon.png",
    "**/public/logo.png",
    "**/public/logo.svg",
    "**/static/favicon.ico",
    "**/static/favicon.png",
    "**/static/favicon.svg",
    "**/assets/favicon.ico",
    "**/assets/favicon.png",
    "**/assets/icon.png",
];

/// Max file size for discovered favicons: 256KB
const MAX_FAVICON_SIZE: u64 = 256 * 1024;

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn read_icon_as_data_url(path: &Path) -> Result<Option<String>, String> {
    let meta = fs::metadata(path)
        .map_err(|e| format!("Failed to stat {}: {}", path.display(), e))?;
    if meta.len() > MAX_FAVICON_SIZE {
        return Ok(None);
    }
    let bytes = fs::read(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let mime = mime_for_ext(ext);
    let b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &bytes,
    );
    Ok(Some(format!("data:{};base64,{}", mime, b64)))
}

#[tauri::command]
async fn discover_project_icon(project_path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&project_path);

        // Phase 1: check exact paths (fast)
        for pattern in FAVICON_EXACT {
            let candidate = root.join(pattern);
            if candidate.is_file() {
                if let Ok(Some(url)) = read_icon_as_data_url(&candidate) {
                    return Ok(Some(url));
                }
            }
        }

        // Phase 2: glob patterns for monorepos (skipping heavy dirs)
        use std::collections::HashSet;
        let skip: HashSet<&str> = ["node_modules", ".git", "dist", "build", ".turbo", ".next", "coverage", "testing"].iter().copied().collect();

        for glob_pattern in FAVICON_GLOBS {
            if let Some(found) = walk_for_glob(root, glob_pattern, &skip) {
                if let Ok(Some(url)) = read_icon_as_data_url(&found) {
                    return Ok(Some(url));
                }
            }
        }

        Ok(None)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Simple glob matcher: splits a `**/name` pattern and walks the tree.
/// Only supports patterns starting with `**/`.
fn walk_for_glob(root: &Path, pattern: &str, skip_dirs: &std::collections::HashSet<&str>) -> Option<PathBuf> {
    let suffix = pattern.strip_prefix("**/")?;
    walk_dir_for_suffix(root, suffix, skip_dirs, 0)
}

fn walk_dir_for_suffix(
    dir: &Path,
    suffix: &str,
    skip_dirs: &std::collections::HashSet<&str>,
    depth: u32,
) -> Option<PathBuf> {
    if depth > 5 { return None; }
    // Check if suffix exists directly under this dir
    let candidate = dir.join(suffix);
    if candidate.is_file() {
        return Some(candidate);
    }
    // Recurse into subdirectories
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if skip_dirs.contains(name) || name.starts_with('.') {
                    continue;
                }
            }
            if let Some(found) = walk_dir_for_suffix(&path, suffix, skip_dirs, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

pub fn run() {
    // Init observability FIRST — before any plugin or tauri::Builder
    // call. The guard must outlive run() itself.
    let observability_guard = observability::init();

    let mut builder = tauri::Builder::default();

    // The Tauri Sentry plugin needs the same sentry::Client our Rust
    // SDK was initialised with so events from the webview share Hub
    // and context. Skip when DSN is missing (contributor builds).
    if let Some(sentry_client) = observability_guard.sentry.as_ref() {
        builder = builder.plugin(tauri_plugin_sentry::init(sentry_client));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .menu(|handle| {
            let check_updates = MenuItemBuilder::with_id("check_for_updates", "Check for Updates...")
                .build(handle)?;
            let app_menu = SubmenuBuilder::new(handle, "Impala")
                .about(None)
                .separator()
                .item(&check_updates)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            MenuBuilder::new(handle)
                .item(&app_menu)
                .item(&edit_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "check_for_updates" {
                let _ = app.emit("check-for-updates", ());
            }
        })
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?;
            fs::create_dir_all(&app_dir)
                .map_err(|e| format!("Failed to create app data dir: {}", e))?;
            let old_db_path = app_dir.join("annotations.db");
            let db_path = app_dir.join("impala.db");
            if old_db_path.exists() && !db_path.exists() {
                fs::rename(&old_db_path, &db_path)
                    .map_err(|e| format!("Failed to rename database: {}", e))?;
            }
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("Failed to open database: {}", e))?;
            annotations::init_db(&conn)
                .map_err(|e| format!("Failed to initialize database: {}", e))?;
            viewed_files::init_db(&conn)
                .map_err(|e| format!("Failed to initialize viewed_files table: {}", e))?;
            worktree_issues::init_db(&conn)
                .map_err(|e| format!("Failed to initialize worktree_issues table: {}", e))?;
            worktrees::init_db(&conn)
                .map_err(|e| format!("Failed to initialize worktrees table: {}", e))?;
            settings::init_db(&conn)
                .map_err(|e| format!("Failed to initialize settings tables: {}", e))?;
            plans::init_db(&conn)
                .map_err(|e| format!("Failed to initialize plans table: {}", e))?;
            plan_annotations::init_db(&conn)
                .map_err(|e| format!("Failed to initialize plan_annotations table: {}", e))?;
            github::init_db(&conn)
                .map_err(|e| format!("Failed to initialize github_pr_status table: {}", e))?;

            let _ = fs::create_dir_all(default_worktree_base_dir());

            // Migrate projects.json → projects table
            {
                let projects_file = app_dir.join("projects.json");
                if projects_file.exists() {
                    if let Ok(contents) = fs::read_to_string(&projects_file) {
                        if let Ok(paths) = serde_json::from_str::<Vec<String>>(&contents) {
                            let _ = settings::save_projects(&conn, &paths);
                        }
                    }
                    let _ = fs::remove_file(&projects_file);
                }
            }

            // Migrate hotkeys.json → settings table
            {
                let hotkeys_file = app_dir.join("hotkeys.json");
                if hotkeys_file.exists() {
                    if let Ok(contents) = fs::read_to_string(&hotkeys_file) {
                        if serde_json::from_str::<serde_json::Value>(&contents).is_ok() {
                            let _ = settings::set_setting(&conn, "hotkeyOverrides", "global", contents.trim());
                        }
                    }
                    let _ = fs::remove_file(&hotkeys_file);
                }
            }

            app.manage(DbState(Mutex::new(conn)));
            app.manage(daemon_client::DaemonState::new());
            app.manage(watcher::WatcherState::new());
            app.manage(plan_scanner::PlanScanCache::new());
            app.manage(plan_scanner::PlanWatcherState::new());
            app.manage(DiffCache(Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(50).unwrap(),
            ))));

            let agent_statuses = Arc::new(hook_server::AgentStatuses(Mutex::new(HashMap::new())));
            let hook_port = hook_server::start(app.handle().clone(), agent_statuses.clone());
            app.manage(HookPort(hook_port));
            app.manage(agent_statuses);

            // Bring up the detached PTY daemon in the background. Until it
            // lands, pty_* commands return "pty daemon not ready". The
            // frontend usually calls them in response to a user action, so
            // a ~100ms async boot is invisible in practice.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match daemon_client::DaemonClient::ensure(&app_handle).await {
                        Ok(client) => {
                            eprintln!(
                                "[impala] pty daemon ready: v{} pid={} sock={}",
                                client.daemon_version,
                                client.daemon_pid,
                                client.paths.sock.display()
                            );
                            debug_assert!(std::env::var("IMPALA_SESSION_ID").is_ok(), "session_id should be set");
                            if let Some(state) =
                                app_handle.try_state::<daemon_client::DaemonState>()
                            {
                                let _ = state.0.set(client);
                            }
                        }
                        Err(e) => {
                            eprintln!("[impala] pty daemon failed to start: {e:#}");
                        }
                    }
                });
            }

            hook_server::install_impala_review_skill();
            hook_server::install_impala_plan_skill();

            // Poll annotations DB for external changes (e.g. MCP server) using data_version.
            // File watchers are unreliable with SQLite WAL mode on macOS.
            {
                let db_path = app_dir.join("impala.db");
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let Ok(poll_conn) = rusqlite::Connection::open_with_flags(
                        &db_path,
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
                    ) else { return };
                    let mut last_version: i64 = poll_conn
                        .pragma_query_value(None, "data_version", |row| row.get(0))
                        .unwrap_or(0);
                    loop {
                        std::thread::sleep(Duration::from_secs(1));
                        if let Ok(version) = poll_conn.pragma_query_value(None, "data_version", |row| row.get::<_, i64>(0)) {
                            if version != last_version {
                                last_version = version;
                                let _ = app_handle.emit("annotations-changed", ());
                            }
                        }
                    }
                });
            }

            // Set window icon for dev mode (bundle icon is used in production)
            if let Some(window) = app.get_webview_window("main") {
                let icon_bytes = include_bytes!("../icons/128x128.png");
                if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
                    let _ = window.set_icon(icon);
                }
            }

            // Register a minimal .app bundle with Launch Services so macOS can
            // resolve our bundle identifier to the Impala icon for notifications
            #[cfg(target_os = "macos")]
            notifications::register_notification_icon(app);

            // Set macOS application icon for dock/window in dev mode
            #[cfg(target_os = "macos")]
            {
                use objc2::MainThreadMarker;
                use objc2::AnyThread;
                use objc2_app_kit::{NSApplication, NSImage};
                use objc2_foundation::NSData;

                let icon_data = include_bytes!("../icons/128x128@2x.png");
                let data = NSData::with_bytes(icon_data);
                if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
                    if let Some(mtm) = MainThreadMarker::new() {
                        let ns_app = NSApplication::sharedApplication(mtm);
                        unsafe { ns_app.setApplicationIconImage(Some(&image)) };
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_git,
            list_worktrees,
            detect_base_branch,
            get_diverged_commits,
            get_changed_files,
            get_commit_diff,
            get_full_commit_diff,
            get_file_at_ref,
            get_branch_diff,
            get_full_branch_diff,
            get_head_commit,
            get_all_changed_files,
            invalidate_branch_cache,
            get_uncommitted_files,
            get_uncommitted_diff,
            discard_file_changes,
            create_worktree,
            delete_worktree,
            list_branches,
            fetch_remote,
            load_projects,
            save_projects,
            create_annotation,
            list_annotations,
            update_annotation,
            delete_annotation,
            create_plan,
            list_plans,
            get_plan,
            get_pr_status,
            refresh_pr_status,
            delete_pr_status,
            get_github_cli_status,
            list_plan_version_files,
            update_plan,
            create_plan_annotation,
            list_plan_annotations,
            update_plan_annotation,
            delete_plan_annotation,
            set_file_viewed,
            get_file_diff_since_commit,
            unset_file_viewed,
            set_files_viewed,
            unset_files_viewed,
            check_viewed_files,
            clear_viewed_files,
            prepare_agent_config,
            get_my_linear_issues,
            search_linear_issues,
            start_linear_issue,
            link_worktree_issue,
            get_worktree_issue,
            get_all_worktree_issues,
            unlink_worktree_issue,
            rename_worktree_title,
            unlink_worktree_title,
            get_setting,
            set_setting,
            delete_setting,
            get_git_info,
            get_default_worktree_base_dir,
            write_linear_context,
            refresh_linear_context,
            clean_linear_context,
            pty::pty_spawn,
            pty::pty_get_buffer,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_is_alive,
            check_generated_files,
            open_in_editor,
            read_plan_file,
            list_plan_files,
            resolve_file_path,
            get_hook_port,
            get_agent_statuses,
            watcher::watch_worktree,
            watcher::unwatch_worktree,
            config::read_project_config,
            config::write_project_config,
            notifications::send_notification,
            notifications::play_notification_sound,
            discover_project_icon,
            hotkeys::read_hotkey_overrides,
            hotkeys::write_hotkey_overrides,
            fonts::list_system_fonts,
            plan_scanner::scan_plan_directories,
            plan_scanner::watch_plan_directories,
            plan_scanner::unwatch_plan_directories,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
