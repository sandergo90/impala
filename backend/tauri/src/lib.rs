mod annotations;
mod config;
mod fonts;
mod git;
mod hook_server;
mod hotkeys;
mod linear;
mod linear_context;
mod notifications;
mod plan_annotations;
mod plans;
mod pty;
mod settings;
mod viewed_files;
mod watcher;
mod worktree_issues;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

pub(crate) struct DbState(pub(crate) Mutex<rusqlite::Connection>);
struct DiffCache(Mutex<lru::LruCache<String, String>>);
struct HookPort(u16);

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
async fn list_worktrees(repo_path: String) -> Result<Vec<git::Worktree>, String> {
    tokio::task::spawn_blocking(move || git::list_worktrees(&repo_path))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
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
    repo_path: String,
    branch_name: String,
    base_branch: Option<String>,
    existing: bool,
) -> Result<git::Worktree, String> {
    tokio::task::spawn_blocking(move || {
        git::create_worktree(&repo_path, &branch_name, base_branch, existing)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn delete_worktree(repo_path: String, worktree_path: String, force: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git::delete_worktree(&repo_path, &worktree_path, force)
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
fn update_plan(
    state: tauri::State<'_, DbState>,
    id: String,
    changes: plans::UpdatePlan,
) -> Result<plans::Plan, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    plans::update_plan(&conn, &id, changes)
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
fn set_file_viewed(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    commit_hash: String,
    file_path: String,
    patch_hash: String,
    viewed_at_commit: Option<String>,
) -> Result<viewed_files::ViewedFile, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::set_viewed(&conn, &worktree_path, &commit_hash, &file_path, &patch_hash, viewed_at_commit.as_deref())
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
    commit_hash: String,
    file_path: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::unset_viewed(&conn, &worktree_path, &commit_hash, &file_path)
}

#[tauri::command]
fn list_viewed_files(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    commit_hash: String,
) -> Result<Vec<viewed_files::ViewedFile>, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::list_viewed(&conn, &worktree_path, &commit_hash)
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
async fn setup_claude_integration() -> Result<String, String> {
    tokio::task::spawn_blocking(setup_claude_integration_sync)
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

fn setup_claude_integration_sync() -> Result<String, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    let mcp_binary = which_mcp_binary(&home)?;

    let settings_path = home.join(".claude.json");
    let mut settings: serde_json::Value = if settings_path.exists() {
        let contents = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse settings: {}", e))?
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
    // Check PATH first
    if let Ok(output) = std::process::Command::new("which").arg("impala-mcp").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }

    // Check cargo install location
    let cargo_bin = home.join(".cargo").join("bin").join("impala-mcp");
    if cargo_bin.exists() {
        return Ok(cargo_bin.to_string_lossy().to_string());
    }

    // Check local dev build (built by `bun run dev` / `bun run build`)
    let exe = std::env::current_exe().ok();
    if let Some(exe_path) = exe {
        // Tauri binary is in backend/tauri/target/... — MCP binary is in backend/mcp/target/...
        if let Some(tauri_target) = exe_path.ancestors().find(|p| p.ends_with("target")) {
            let mcp_debug = tauri_target.parent().unwrap().parent().unwrap()
                .join("mcp").join("target").join("debug").join("impala-mcp");
            if mcp_debug.exists() {
                return Ok(mcp_debug.to_string_lossy().to_string());
            }
            let mcp_release = tauri_target.parent().unwrap().parent().unwrap()
                .join("mcp").join("target").join("release").join("impala-mcp");
            if mcp_release.exists() {
                return Ok(mcp_release.to_string_lossy().to_string());
            }
        }
    }

    Err("impala-mcp binary not found. Build it with: cd backend/mcp && cargo install --path .".to_string())
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
    tauri::Builder::default()
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
            settings::init_db(&conn)
                .map_err(|e| format!("Failed to initialize settings tables: {}", e))?;
            plans::init_db(&conn)
                .map_err(|e| format!("Failed to initialize plans table: {}", e))?;
            plan_annotations::init_db(&conn)
                .map_err(|e| format!("Failed to initialize plan_annotations table: {}", e))?;

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
            app.manage(pty::PtyState::new());
            app.manage(watcher::WatcherState::new());
            app.manage(DiffCache(Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(50).unwrap(),
            ))));

            let hook_port = hook_server::start(app.handle().clone());
            app.manage(HookPort(hook_port));

            hook_server::install_claude_hooks();
            hook_server::install_impala_review_skill();

            // Auto-register the Impala MCP server in Claude Code settings
            if let Err(_) = setup_claude_integration_sync() {
                // Binary may not be installed yet — not fatal
            }

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
            create_worktree,
            delete_worktree,
            list_branches,
            load_projects,
            save_projects,
            create_annotation,
            list_annotations,
            update_annotation,
            delete_annotation,
            create_plan,
            list_plans,
            get_plan,
            update_plan,
            create_plan_annotation,
            list_plan_annotations,
            update_plan_annotation,
            delete_plan_annotation,
            set_file_viewed,
            get_file_diff_since_commit,
            unset_file_viewed,
            list_viewed_files,
            clear_viewed_files,
            setup_claude_integration,
            get_my_linear_issues,
            search_linear_issues,
            start_linear_issue,
            link_worktree_issue,
            get_worktree_issue,
            get_all_worktree_issues,
            unlink_worktree_issue,
            get_setting,
            set_setting,
            delete_setting,
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
            resolve_file_path,
            get_hook_port,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
