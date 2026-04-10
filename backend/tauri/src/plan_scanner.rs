use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::settings;
use crate::DbState;

#[derive(Debug, Serialize, Clone)]
pub struct DiscoveredPlan {
    pub path: String,
    pub title: String,
    pub is_directory: bool,
    pub modified_at: String,
}

pub struct PlanScanCache {
    cache: Mutex<HashMap<String, Vec<DiscoveredPlan>>>,
}

impl PlanScanCache {
    pub fn new() -> Self {
        PlanScanCache {
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn invalidate(&self, worktree_path: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.remove(worktree_path);
        }
    }

    pub fn get_or_scan(&self, worktree_path: &str, extra_dirs: &[String]) -> Vec<DiscoveredPlan> {
        if let Ok(mut cache) = self.cache.lock() {
            if let Some(plans) = cache.get(worktree_path) {
                return plans.clone();
            }
            let plans = scan(worktree_path, extra_dirs);
            cache.insert(worktree_path.to_string(), plans.clone());
            plans
        } else {
            scan(worktree_path, extra_dirs)
        }
    }
}

fn extract_title(file_path: &Path) -> Option<String> {
    let file = fs::File::open(file_path).ok()?;
    let reader = BufReader::new(file);
    for (i, line) in reader.lines().enumerate() {
        if i >= 10 {
            break;
        }
        if let Ok(line) = line {
            let trimmed = line.trim();
            if let Some(heading) = trimmed.strip_prefix("# ") {
                let title = heading.trim();
                if !title.is_empty() {
                    return Some(title.to_string());
                }
            }
        }
    }
    None
}

fn get_modified_at(path: &Path) -> String {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339()
        })
        .unwrap_or_default()
}

fn scan(worktree_path: &str, extra_dirs: &[String]) -> Vec<DiscoveredPlan> {
    let root = Path::new(worktree_path);
    let default_dirs = vec![
        root.join(".claude/plans"),
        root.join("docs/plans"),
    ];

    let mut all_dirs: Vec<std::path::PathBuf> = default_dirs;
    for dir in extra_dirs {
        let p = Path::new(dir);
        if p.is_absolute() {
            all_dirs.push(p.to_path_buf());
        } else {
            all_dirs.push(root.join(dir));
        }
    }

    let mut plans: Vec<DiscoveredPlan> = Vec::new();

    for dir in &all_dirs {
        if !dir.is_dir() {
            continue;
        }

        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                // Plan directory: must contain overview.md
                let overview = path.join("overview.md");
                if overview.is_file() {
                    let title = extract_title(&overview).unwrap_or_else(|| {
                        path.file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default()
                    });
                    let modified_at = get_modified_at(&overview);
                    plans.push(DiscoveredPlan {
                        path: path.to_string_lossy().to_string(),
                        title,
                        is_directory: true,
                        modified_at,
                    });
                }
            } else if path.extension().map_or(false, |ext| ext == "md") {
                // Standalone markdown plan file
                let title = extract_title(&path).unwrap_or_else(|| {
                    path.file_stem()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                });
                let modified_at = get_modified_at(&path);
                plans.push(DiscoveredPlan {
                    path: path.to_string_lossy().to_string(),
                    title,
                    is_directory: false,
                    modified_at,
                });
            }
        }
    }

    // Sort by modified_at descending (newest first)
    plans.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    plans
}

fn get_extra_dirs(db_state: &DbState) -> Vec<String> {
    let conn = match db_state.0.lock() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    match settings::get_setting(&conn, "planDirectories", "global") {
        Ok(Some(value)) => serde_json::from_str::<Vec<String>>(&value).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn plan_directories(worktree_path: &str, extra_dirs: &[String]) -> Vec<std::path::PathBuf> {
    let root = Path::new(worktree_path);
    let mut dirs = vec![
        root.join(".claude/plans"),
        root.join("docs/plans"),
    ];
    for dir in extra_dirs {
        let p = Path::new(dir);
        if p.is_absolute() {
            dirs.push(p.to_path_buf());
        } else {
            dirs.push(root.join(dir));
        }
    }
    dirs
}

pub struct PlanWatcherState {
    watchers: Mutex<HashMap<String, Vec<RecommendedWatcher>>>,
}

impl PlanWatcherState {
    pub fn new() -> Self {
        PlanWatcherState {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
pub fn scan_plan_directories(
    state: tauri::State<'_, DbState>,
    scan_cache: tauri::State<'_, PlanScanCache>,
    worktree_path: String,
) -> Result<Vec<DiscoveredPlan>, String> {
    let extra_dirs = get_extra_dirs(&state);
    Ok(scan_cache.get_or_scan(&worktree_path, &extra_dirs))
}

#[tauri::command]
pub fn watch_plan_directories(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    scan_cache: tauri::State<'_, PlanScanCache>,
    watcher_state: tauri::State<'_, PlanWatcherState>,
    worktree_path: String,
) -> Result<(), String> {
    let mut watchers_map = watcher_state
        .watchers
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    // Don't double-watch
    if watchers_map.contains_key(&worktree_path) {
        return Ok(());
    }

    let extra_dirs = get_extra_dirs(&state);
    let dirs = plan_directories(&worktree_path, &extra_dirs);

    let mut dir_watchers: Vec<RecommendedWatcher> = Vec::new();

    for dir in &dirs {
        if !dir.is_dir() {
            continue;
        }

        let last_event = std::sync::Arc::new(Mutex::new(Instant::now()));
        let debounce_flag = std::sync::Arc::new(Mutex::new(false));
        let app = app_handle.clone();
        let wt_path = worktree_path.clone();

        let last_ref = last_event.clone();
        let flag_ref = debounce_flag.clone();

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(_event) = res {
                    if let Ok(mut last) = last_ref.lock() {
                        *last = Instant::now();
                    }

                    let mut flag = flag_ref.lock().unwrap();
                    if !*flag {
                        *flag = true;
                        let last_inner = last_event.clone();
                        let app_inner = app.clone();
                        let wt_inner = wt_path.clone();
                        let flag_inner = flag_ref.clone();

                        std::thread::spawn(move || {
                            loop {
                                std::thread::sleep(Duration::from_millis(2000));
                                let elapsed = {
                                    let last = last_inner.lock().unwrap();
                                    last.elapsed()
                                };
                                if elapsed >= Duration::from_millis(2000) {
                                    let _ = app_inner
                                        .emit("plan-directories-changed", &wt_inner);
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
        )
        .map_err(|e| format!("Failed to create plan watcher: {}", e))?;

        watcher
            .watch(dir.as_path(), RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch plan directory: {}", e))?;

        dir_watchers.push(watcher);
    }

    // Invalidate cache so next scan picks up changes
    scan_cache.invalidate(&worktree_path);

    watchers_map.insert(worktree_path, dir_watchers);
    Ok(())
}

#[tauri::command]
pub fn unwatch_plan_directories(
    watcher_state: tauri::State<'_, PlanWatcherState>,
    scan_cache: tauri::State<'_, PlanScanCache>,
    worktree_path: String,
) -> Result<(), String> {
    let mut watchers_map = watcher_state
        .watchers
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    watchers_map.remove(&worktree_path);
    scan_cache.invalidate(&worktree_path);
    Ok(())
}
