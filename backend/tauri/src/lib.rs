mod annotations;
mod git;
mod pty;
mod viewed_files;
mod watcher;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use notify::{Config, Event, RecommendedWatcher, Watcher, RecursiveMode};
use tauri::{Emitter, Manager};

struct DbState(Mutex<rusqlite::Connection>);
struct DiffCache(Mutex<lru::LruCache<String, String>>);

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
fn get_full_commit_diff(
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
    let result = git::get_full_commit_diff(&worktree_path, &commit_hash)?;
    {
        let mut c = cache.0.lock().map_err(|e| format!("Cache lock error: {}", e))?;
        c.put(key, result.clone());
    }
    Ok(result)
}

#[tauri::command]
fn get_branch_diff(worktree_path: String, file_path: String) -> Result<String, String> {
    git::get_branch_diff(&worktree_path, &file_path)
}

#[tauri::command]
fn get_uncommitted_files(worktree_path: String) -> Result<Vec<git::ChangedFile>, String> {
    git::get_uncommitted_files(&worktree_path)
}

#[tauri::command]
fn get_uncommitted_diff(worktree_path: String) -> Result<String, String> {
    git::get_uncommitted_diff(&worktree_path)
}

#[tauri::command]
fn get_full_branch_diff(
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
    let result = git::get_full_branch_diff(&worktree_path)?;
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
fn get_all_changed_files(worktree_path: String) -> Result<Vec<git::ChangedFile>, String> {
    git::get_all_changed_files(&worktree_path)
}

#[tauri::command]
fn create_worktree(
    repo_path: String,
    branch_name: String,
    base_branch: Option<String>,
    existing: bool,
) -> Result<git::Worktree, String> {
    git::create_worktree(&repo_path, &branch_name, base_branch, existing)
}

#[tauri::command]
fn list_branches(repo_path: String) -> Result<Vec<git::BranchInfo>, String> {
    git::list_branches(&repo_path)
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
fn set_file_viewed(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    commit_hash: String,
    file_path: String,
    patch_hash: String,
) -> Result<viewed_files::ViewedFile, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    viewed_files::set_viewed(&conn, &worktree_path, &commit_hash, &file_path, &patch_hash)
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
fn setup_claude_integration() -> Result<String, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    let mcp_binary = which_mcp_binary(&home)?;

    let settings_path = home.join(".claude").join("settings.local.json");
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
        .insert("differ".to_string(), serde_json::json!({
            "command": mcp_binary,
            "args": []
        }));

    fs::create_dir_all(settings_path.parent().unwrap())
        .map_err(|e| format!("Failed to create .claude directory: {}", e))?;

    let formatted = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, formatted)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(mcp_binary)
}

fn which_mcp_binary(home: &std::path::Path) -> Result<String, String> {
    if let Ok(output) = std::process::Command::new("which").arg("differ-mcp").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }

    let cargo_bin = home.join(".cargo").join("bin").join("differ-mcp");
    if cargo_bin.exists() {
        return Ok(cargo_bin.to_string_lossy().to_string());
    }

    Err("differ-mcp binary not found. Build it with: cd backend/mcp && cargo install --path .".to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
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
            viewed_files::init_db(&conn)
                .map_err(|e| format!("Failed to initialize viewed_files table: {}", e))?;
            app.manage(DbState(Mutex::new(conn)));
            app.manage(pty::PtyState::new());
            app.manage(watcher::WatcherState::new());
            app.manage(DiffCache(Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(50).unwrap(),
            ))));

            // Watch annotations DB parent dir for external changes (e.g. MCP server)
            {
                let db_dir = app_dir.clone();
                let app_handle = app.handle().clone();
                let last_db_event = Arc::new(Mutex::new(Instant::now()));
                let db_debounce_flag = Arc::new(Mutex::new(false));

                let last_ref = last_db_event.clone();
                let flag_ref = db_debounce_flag.clone();

                let mut db_watcher = RecommendedWatcher::new(
                    move |res: Result<Event, notify::Error>| {
                        if res.is_ok() {
                            if let Ok(mut last) = last_ref.lock() {
                                *last = Instant::now();
                            }
                            let mut flag = flag_ref.lock().unwrap();
                            if !*flag {
                                *flag = true;
                                let app_ref = app_handle.clone();
                                let last_inner = last_db_event.clone();
                                let flag_inner = db_debounce_flag.clone();
                                std::thread::spawn(move || {
                                    loop {
                                        std::thread::sleep(Duration::from_millis(300));
                                        let elapsed = {
                                            let last = last_inner.lock().unwrap();
                                            last.elapsed()
                                        };
                                        if elapsed >= Duration::from_millis(300) {
                                            let _ = app_ref.emit("annotations-changed", ());
                                            let mut f = flag_inner.lock().unwrap();
                                            *f = false;
                                            break;
                                        }
                                    }
                                });
                            }
                        }
                    },
                    Config::default(),
                ).map_err(|e| format!("Failed to create DB watcher: {}", e))?;

                // Watch parent dir (catches WAL/SHM changes too)
                let _ = db_watcher.watch(db_dir.as_ref(), RecursiveMode::NonRecursive);
                app.manage(db_watcher);
            }

            // Set window icon for dev mode (bundle icon is used in production)
            if let Some(window) = app.get_webview_window("main") {
                let icon_bytes = include_bytes!("../icons/128x128.png");
                if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
                    let _ = window.set_icon(icon);
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
            get_branch_diff,
            get_full_branch_diff,
            get_all_changed_files,
            invalidate_branch_cache,
            get_uncommitted_files,
            get_uncommitted_diff,
            create_worktree,
            list_branches,
            load_projects,
            save_projects,
            create_annotation,
            list_annotations,
            update_annotation,
            delete_annotation,
            set_file_viewed,
            unset_file_viewed,
            list_viewed_files,
            clear_viewed_files,
            setup_claude_integration,
            pty::pty_spawn,
            pty::pty_get_buffer,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            watcher::watch_worktree,
            watcher::unwatch_worktree,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
