use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

pub struct WatcherState {
    watchers: Mutex<HashMap<String, WatcherSet>>,
}

/// Holds both the worktree watcher and an optional git-refs watcher
pub struct WatcherSet {
    _worktree: RecommendedWatcher,
    _git_refs: Option<RecommendedWatcher>,
}

impl WatcherState {
    pub fn new() -> Self {
        WatcherState {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

fn sanitize_event_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[tauri::command]
pub fn watch_worktree(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    worktree_path: String,
) -> Result<(), String> {
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    // Don't double-watch
    if watchers.contains_key(&worktree_path) {
        return Ok(());
    }

    let safe_id = sanitize_event_id(&worktree_path);
    let app = app_handle.clone();

    let last_event = std::sync::Arc::new(Mutex::new(Instant::now()));
    let debounce_flag = std::sync::Arc::new(Mutex::new(false));

    // Build the debounced emit callback, shared by both watchers
    let make_emitter = |last_event: std::sync::Arc<Mutex<Instant>>,
                        debounce_flag: std::sync::Arc<Mutex<bool>>,
                        app: tauri::AppHandle,
                        safe_id: String| {
        move || {
            let mut flag = debounce_flag.lock().unwrap();
            if !*flag {
                *flag = true;
                let last_ref = last_event.clone();
                let app_ref = app.clone();
                let sid = safe_id.clone();
                let flag_ref = debounce_flag.clone();

                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_millis(2000));
                        let elapsed = {
                            let last = last_ref.lock().unwrap();
                            last.elapsed()
                        };
                        if elapsed >= Duration::from_millis(2000) {
                            let event_name = format!("fs-changed-{}", sid);
                            let _ = app_ref.emit(&event_name, ());
                            let mut f = flag_ref.lock().unwrap();
                            *f = false;
                            break;
                        }
                    }
                });
            }
        }
    };

    let emit_fn = make_emitter(
        last_event.clone(), debounce_flag.clone(), app.clone(), safe_id.clone(),
    );

    // Worktree watcher: file changes (ignores .git/, node_modules/, target/)
    let wt_last = last_event.clone();
    let wt_emit = emit_fn.clone();
    let mut wt_watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let dominated_by_git = event.paths.iter().all(|p| {
                    let s = p.to_string_lossy();
                    s.contains("/.git/") || s.contains("\\.git\\") || s.ends_with("/.git") || s.ends_with("\\.git")
                });
                if dominated_by_git { return; }

                let dominated_by_ignore = event.paths.iter().all(|p| {
                    let s = p.to_string_lossy();
                    s.contains("/node_modules/") || s.contains("/target/")
                        || s.contains("/dist/") || s.contains("/.next/")
                        || s.contains("/.turbo/") || s.contains("/.nuxt/")
                        || s.contains("/.output/") || s.contains("/.vite/")
                });
                if dominated_by_ignore { return; }

                if let Ok(mut last) = wt_last.lock() { *last = Instant::now(); }
                wt_emit();
            }
        },
        Config::default(),
    ).map_err(|e| format!("Failed to create watcher: {}", e))?;

    wt_watcher
        .watch(Path::new(&worktree_path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    // Git refs watcher: watch refs/ dir in the shared git dir for commit/branch changes
    let git_refs_watcher = resolve_git_refs_dir(&worktree_path).and_then(|refs_dir| {
        let refs_last = last_event.clone();
        let refs_emit = emit_fn.clone();
        let mut refs_watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(_event) = res {
                    if let Ok(mut last) = refs_last.lock() { *last = Instant::now(); }
                    refs_emit();
                }
            },
            Config::default(),
        ).ok()?;
        refs_watcher.watch(Path::new(&refs_dir), RecursiveMode::Recursive).ok()?;
        Some(refs_watcher)
    });

    watchers.insert(worktree_path, WatcherSet {
        _worktree: wt_watcher,
        _git_refs: git_refs_watcher,
    });
    Ok(())
}

/// Resolve the git refs directory, handling both regular repos and worktrees.
/// Returns the path to the shared refs/ directory.
fn resolve_git_refs_dir(worktree_path: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(worktree_path)
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    let git_common_dir = String::from_utf8(output.stdout).ok()?.trim().to_string();
    let refs_path = if Path::new(&git_common_dir).is_absolute() {
        format!("{}/refs", git_common_dir)
    } else {
        format!("{}/{}/refs", worktree_path, git_common_dir)
    };
    if Path::new(&refs_path).exists() { Some(refs_path) } else { None }
}

#[tauri::command]
pub fn unwatch_worktree(
    state: tauri::State<'_, WatcherState>,
    worktree_path: String,
) -> Result<(), String> {
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    watchers.remove(&worktree_path);
    Ok(())
}
