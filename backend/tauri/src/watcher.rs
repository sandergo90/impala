use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

pub struct WatcherState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
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

    // Debounce: only emit after 500ms of quiet
    let last_event = std::sync::Arc::new(Mutex::new(Instant::now()));
    let last_event_clone = last_event.clone();
    let safe_id_clone = safe_id.clone();
    let app_clone = app.clone();

    // Spawn a debounce thread
    let debounce_flag = std::sync::Arc::new(Mutex::new(false));
    let debounce_flag_clone = debounce_flag.clone();

    let watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                // Ignore .git directory changes
                let dominated_by_git = event.paths.iter().all(|p| {
                    p.to_string_lossy().contains("/.git/") || p.to_string_lossy().contains("\\.git\\")
                });
                if dominated_by_git {
                    return;
                }

                // Ignore node_modules and target
                let dominated_by_ignore = event.paths.iter().all(|p| {
                    let s = p.to_string_lossy();
                    s.contains("/node_modules/") || s.contains("/target/")
                });
                if dominated_by_ignore {
                    return;
                }

                // Update last event time and schedule emit
                if let Ok(mut last) = last_event_clone.lock() {
                    *last = Instant::now();
                }

                let mut flag = debounce_flag_clone.lock().unwrap();
                if !*flag {
                    *flag = true;
                    let last_ref = last_event.clone();
                    let app_ref = app_clone.clone();
                    let sid = safe_id_clone.clone();
                    let flag_ref = debounce_flag.clone();

                    std::thread::spawn(move || {
                        loop {
                            std::thread::sleep(Duration::from_millis(500));
                            let elapsed = {
                                let last = last_ref.lock().unwrap();
                                last.elapsed()
                            };
                            if elapsed >= Duration::from_millis(500) {
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
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    let path = Path::new(&worktree_path);
    let mut watcher = watcher;
    watcher
        .watch(path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    watchers.insert(worktree_path, watcher);
    Ok(())
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
