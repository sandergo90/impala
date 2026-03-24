mod annotations;
mod git;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

struct DbState(Mutex<rusqlite::Connection>);

fn get_projects_file(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    Ok(app_dir.join("projects.json"))
}

#[tauri::command]
fn check_git() -> Result<String, String> {
    let output = std::process::Command::new("git")
        .arg("--version")
        .output()
        .map_err(|_| "Git is not installed. Please install Git to use Differ.".to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err("Git is not installed. Please install Git to use Differ.".to_string())
    }
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?;
            fs::create_dir_all(&app_dir)
                .map_err(|e| format!("Failed to create app data dir: {}", e))?;
            let db_path = app_dir.join("annotations.db");
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("Failed to open database: {}", e))?;
            annotations::init_db(&conn)
                .map_err(|e| format!("Failed to initialize database: {}", e))?;
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_git,
            list_worktrees,
            detect_base_branch,
            get_diverged_commits,
            get_changed_files,
            get_commit_diff,
            get_branch_diff,
            get_all_changed_files,
            load_projects,
            save_projects,
            create_annotation,
            list_annotations,
            update_annotation,
            delete_annotation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
