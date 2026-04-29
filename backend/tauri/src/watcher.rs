use notify::event::{ModifyKind, RenameMode};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Max number of raw notify events we will translate per debounce window.
/// Above this, we emit a single `overflow` event so the renderer falls
/// back to a full refetch instead of paying per-path translation cost.
const OVERFLOW_THRESHOLD: usize = 200;

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FsEventKind {
    Create,
    Update,
    Delete,
    Rename,
    Overflow,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    pub kind: FsEventKind,
    pub path: Option<String>,
    pub old_path: Option<String>,
    pub is_directory: Option<bool>,
}

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

fn to_posix(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Strip the worktree root prefix and return a POSIX-normalised relative path,
/// or None if the path isn't under the worktree.
fn relativize(worktree_root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(worktree_root).ok().map(to_posix)
}

fn is_dominated_by_git(paths: &[PathBuf]) -> bool {
    paths.iter().all(|p| {
        let s = p.to_string_lossy();
        s.contains("/.git/")
            || s.contains("\\.git\\")
            || s.ends_with("/.git")
            || s.ends_with("\\.git")
    })
}

fn is_dominated_by_ignore(paths: &[PathBuf]) -> bool {
    paths.iter().all(|p| {
        let s = p.to_string_lossy();
        s.contains("/node_modules/")
            || s.contains("/target/")
            || s.contains("/dist/")
            || s.contains("/.next/")
            || s.contains("/.turbo/")
            || s.contains("/.nuxt/")
            || s.contains("/.output/")
            || s.contains("/.vite/")
    })
}

fn metadata_is_dir(path: &Path) -> Option<bool> {
    std::fs::metadata(path).map(|m| m.is_dir()).ok()
}

/// Translate a queue of raw notify events into structured FsEvents.
///
/// macOS note: FSEvents does not pair the old + new sides of a rename, so we
/// only see `RenameMode::Any` with a single path. We probe the filesystem to
/// decide whether it's the appearance side (emit `create`) or the disappearance
/// side (emit `delete`). On Linux inotify we get proper `From`/`To`/`Both`
/// pairing, so we can emit `rename` with both paths.
fn translate_events(worktree_root: &Path, queue: Vec<Event>) -> Vec<FsEvent> {
    if queue.len() > OVERFLOW_THRESHOLD {
        return vec![FsEvent {
            kind: FsEventKind::Overflow,
            path: None,
            old_path: None,
            is_directory: None,
        }];
    }

    let mut out: Vec<FsEvent> = Vec::new();
    // `From` events awaiting a matching `To` (Linux inotify path).
    let mut pending_from: HashSet<PathBuf> = HashSet::new();

    for event in queue {
        match event.kind {
            EventKind::Create(_) => {
                if let Some(p) = event.paths.first() {
                    if let Some(rel) = relativize(worktree_root, p) {
                        out.push(FsEvent {
                            kind: FsEventKind::Create,
                            path: Some(rel),
                            old_path: None,
                            is_directory: metadata_is_dir(p),
                        });
                    }
                }
            }
            EventKind::Remove(_) => {
                if let Some(p) = event.paths.first() {
                    if let Some(rel) = relativize(worktree_root, p) {
                        out.push(FsEvent {
                            kind: FsEventKind::Delete,
                            path: Some(rel),
                            old_path: None,
                            is_directory: None,
                        });
                    }
                }
            }
            EventKind::Modify(ModifyKind::Name(rename_mode)) => {
                match rename_mode {
                    // Linux: synthesized event carrying both sides.
                    RenameMode::Both => {
                        if event.paths.len() >= 2 {
                            let old = &event.paths[0];
                            let new = &event.paths[1];
                            if let (Some(old_rel), Some(new_rel)) = (
                                relativize(worktree_root, old),
                                relativize(worktree_root, new),
                            ) {
                                out.push(FsEvent {
                                    kind: FsEventKind::Rename,
                                    path: Some(new_rel),
                                    old_path: Some(old_rel),
                                    is_directory: metadata_is_dir(new),
                                });
                            }
                        }
                    }
                    // Linux: half of a rename. Buffer until the matching To arrives.
                    RenameMode::From => {
                        if let Some(p) = event.paths.first().cloned() {
                            pending_from.insert(p);
                        }
                    }
                    RenameMode::To => {
                        // On Linux the synthesized `Both` event also arrives,
                        // so we generally never reach this with an unmatched
                        // From. Fall back: emit as `create`.
                        if let Some(p) = event.paths.first() {
                            if let Some(rel) = relativize(worktree_root, p) {
                                out.push(FsEvent {
                                    kind: FsEventKind::Create,
                                    path: Some(rel),
                                    old_path: None,
                                    is_directory: metadata_is_dir(p),
                                });
                            }
                        }
                    }
                    // macOS FSEvents: no pairing available — see notify-8.2.0
                    // src/fsevent.rs ("FSEvents provides no mechanism to associate
                    // the old and new sides of a rename event"). Probe the
                    // filesystem to decide create vs delete.
                    RenameMode::Any | RenameMode::Other => {
                        if let Some(p) = event.paths.first() {
                            if let Some(rel) = relativize(worktree_root, p) {
                                match std::fs::metadata(p) {
                                    Ok(meta) => out.push(FsEvent {
                                        kind: FsEventKind::Create,
                                        path: Some(rel),
                                        old_path: None,
                                        is_directory: Some(meta.is_dir()),
                                    }),
                                    Err(_) => out.push(FsEvent {
                                        kind: FsEventKind::Delete,
                                        path: Some(rel),
                                        old_path: None,
                                        is_directory: None,
                                    }),
                                }
                            }
                        }
                    }
                }
            }
            EventKind::Modify(_) => {
                if let Some(p) = event.paths.first() {
                    if let Some(rel) = relativize(worktree_root, p) {
                        out.push(FsEvent {
                            kind: FsEventKind::Update,
                            path: Some(rel),
                            old_path: None,
                            is_directory: metadata_is_dir(p),
                        });
                    }
                }
            }
            // Skip Access, Any, Other.
            _ => {}
        }
    }

    // Any unmatched `From` events become deletes.
    for src in pending_from.into_iter() {
        if let Some(rel) = relativize(worktree_root, &src) {
            out.push(FsEvent {
                kind: FsEventKind::Delete,
                path: Some(rel),
                old_path: None,
                is_directory: None,
            });
        }
    }

    out
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

    let last_event = Arc::new(Mutex::new(Instant::now()));
    let debounce_flag = Arc::new(Mutex::new(false));
    // Raw notify events accumulated since the last flush.
    let event_queue: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));

    let worktree_root = PathBuf::from(&worktree_path);

    // Worktree watcher: file changes (ignores .git/, node_modules/, target/, etc.)
    let wt_last = last_event.clone();
    let wt_flag = debounce_flag.clone();
    let wt_queue = event_queue.clone();
    let wt_app = app.clone();
    let wt_sid = safe_id.clone();
    let wt_root = worktree_root.clone();

    let mut wt_watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            if is_dominated_by_git(&event.paths) {
                return;
            }
            if is_dominated_by_ignore(&event.paths) {
                return;
            }

            // Push raw event into queue; flush thread will translate.
            if let Ok(mut q) = wt_queue.lock() {
                q.push(event);
            }
            if let Ok(mut last) = wt_last.lock() {
                *last = Instant::now();
            }

            // Spin up debounce thread if not already running.
            let mut flag = match wt_flag.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if *flag {
                return;
            }
            *flag = true;
            drop(flag);
            let last_ref = wt_last.clone();
            let flag_ref = wt_flag.clone();
            let queue_ref = wt_queue.clone();
            let app_ref = wt_app.clone();
            let sid = wt_sid.clone();
            let root = wt_root.clone();

            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(2000));
                    let elapsed = {
                        let last = last_ref.lock().unwrap();
                        last.elapsed()
                    };
                    if elapsed >= Duration::from_millis(2000) {
                        let drained: Vec<Event> = {
                            let mut q = queue_ref.lock().unwrap();
                            std::mem::take(&mut *q)
                        };

                        let fs_events = translate_events(&root, drained);

                        // Per-path structured events.
                        let event_name = format!("fs-event-{}", sid);
                        for ev in &fs_events {
                            let _ = app_ref.emit(&event_name, ev);
                        }

                        // Legacy coarse event — preserved for CommitPanel /
                        // usePrStatusSync, which only need a "something changed".
                        let legacy_name = format!("fs-changed-{}", sid);
                        let _ = app_ref.emit(&legacy_name, ());

                        let mut f = flag_ref.lock().unwrap();
                        *f = false;
                        break;
                    }
                }
            });
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    wt_watcher
        .watch(Path::new(&worktree_path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    // Git refs watcher: only fires the legacy fs-changed event for PR status / commit panel.
    // It deliberately does NOT participate in fs-event-{sid} (file-tree).
    let refs_last = last_event.clone();
    let refs_flag = debounce_flag.clone();
    let refs_app = app.clone();
    let refs_sid = safe_id.clone();
    let git_refs_watcher = resolve_git_refs_dir(&worktree_path).and_then(|refs_dir| {
        let mut refs_watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if res.is_err() {
                    return;
                }
                if let Ok(mut last) = refs_last.lock() {
                    *last = Instant::now();
                }
                let mut flag = match refs_flag.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if *flag {
                    return;
                }
                *flag = true;
                drop(flag);
                let last_ref = refs_last.clone();
                let flag_ref = refs_flag.clone();
                let app_ref = refs_app.clone();
                let sid = refs_sid.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(2000));
                    let elapsed = {
                        let last = last_ref.lock().unwrap();
                        last.elapsed()
                    };
                    if elapsed >= Duration::from_millis(2000) {
                        let legacy_name = format!("fs-changed-{}", sid);
                        let _ = app_ref.emit(&legacy_name, ());
                        let mut f = flag_ref.lock().unwrap();
                        *f = false;
                        break;
                    }
                });
            },
            Config::default(),
        )
        .ok()?;
        refs_watcher
            .watch(Path::new(&refs_dir), RecursiveMode::Recursive)
            .ok()?;
        Some(refs_watcher)
    });

    watchers.insert(
        worktree_path,
        WatcherSet {
            _worktree: wt_watcher,
            _git_refs: git_refs_watcher,
        },
    );
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
    if !output.status.success() {
        return None;
    }
    let git_common_dir = String::from_utf8(output.stdout).ok()?.trim().to_string();
    let refs_path = if Path::new(&git_common_dir).is_absolute() {
        format!("{}/refs", git_common_dir)
    } else {
        format!("{}/{}/refs", worktree_path, git_common_dir)
    };
    if Path::new(&refs_path).exists() {
        Some(refs_path)
    } else {
        None
    }
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
