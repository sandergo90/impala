mod git;

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn get_projects_file(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    Ok(app_dir.join("projects.json"))
}

#[tauri::command]
fn load_projects(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let path = get_projects_file(&app_handle)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read projects.json: {}", e))?;
    serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse projects.json: {}", e))
}

#[tauri::command]
fn save_projects(app_handle: tauri::AppHandle, projects: Vec<String>) -> Result<(), String> {
    let path = get_projects_file(&app_handle)?;
    let contents = serde_json::to_string_pretty(&projects)
        .map_err(|e| format!("Failed to serialize projects: {}", e))?;
    fs::write(&path, contents)
        .map_err(|e| format!("Failed to write projects.json: {}", e))
}

#[tauri::command]
fn list_worktrees(repo_path: String) -> Result<Vec<git::Worktree>, String> {
    git::list_worktrees(&repo_path)
}

#[tauri::command]
fn detect_base_branch(worktree_path: String) -> Result<String, String> {
    git::detect_base_branch(&worktree_path)
}

#[tauri::command]
fn get_diverged_commits(
    worktree_path: String,
    base_branch: Option<String>,
) -> Result<Vec<git::CommitInfo>, String> {
    git::get_diverged_commits(&worktree_path, base_branch)
}

#[tauri::command]
fn get_changed_files(
    worktree_path: String,
    commit_hash: String,
) -> Result<Vec<git::ChangedFile>, String> {
    git::get_changed_files(&worktree_path, &commit_hash)
}

#[tauri::command]
fn get_commit_diff(
    worktree_path: String,
    commit_hash: String,
    file_path: String,
) -> Result<String, String> {
    git::get_commit_diff(&worktree_path, &commit_hash, &file_path)
}

#[tauri::command]
fn get_branch_diff(worktree_path: String, file_path: String) -> Result<String, String> {
    git::get_branch_diff(&worktree_path, &file_path)
}

#[tauri::command]
fn get_all_changed_files(worktree_path: String) -> Result<Vec<git::ChangedFile>, String> {
    git::get_all_changed_files(&worktree_path)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_worktrees,
            detect_base_branch,
            get_diverged_commits,
            get_changed_files,
            get_commit_diff,
            get_branch_diff,
            get_all_changed_files,
            load_projects,
            save_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
