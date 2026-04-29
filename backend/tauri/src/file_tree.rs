use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FsKind {
    File,
    Directory,
    Symlink,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub kind: FsKind,
    pub relative_path: String, // POSIX-style, relative to worktree root
    pub ignored: bool,
}

fn to_posix(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn build_gitignore(worktree_root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(worktree_root);
    let _ = builder.add(worktree_root.join(".gitignore"));
    let _ = builder.add(worktree_root.join(".git/info/exclude"));
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// Per-worktree Gitignore matcher cache, keyed by worktree root path.
/// Reuses the previously-built `Gitignore` as long as `.gitignore`'s mtime
/// is unchanged. Avoids rebuilding on every `list_directory` call.
#[derive(Default)]
pub struct GitignoreCache {
    inner: Mutex<HashMap<String, (Gitignore, Option<SystemTime>)>>,
}

impl GitignoreCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, worktree_root: &Path) -> Gitignore {
        let key = worktree_root.to_string_lossy().to_string();
        let current_mtime = std::fs::metadata(worktree_root.join(".gitignore"))
            .and_then(|m| m.modified())
            .ok();

        {
            let cache = self.inner.lock().expect("gitignore cache poisoned");
            if let Some((gi, mtime)) = cache.get(&key) {
                if *mtime == current_mtime {
                    return gi.clone();
                }
            }
        }

        let gi = build_gitignore(worktree_root);
        let mut cache = self.inner.lock().expect("gitignore cache poisoned");
        cache.insert(key, (gi.clone(), current_mtime));
        gi
    }
}

#[tauri::command]
pub async fn list_directory(
    state: tauri::State<'_, GitignoreCache>,
    worktree_path: String,
    rel_dir: String,
) -> Result<Vec<FsEntry>, String> {
    // tauri::State guards aren't Send across spawn_blocking, so resolve the
    // Gitignore matcher up-front and move the clone into the closure.
    let root = PathBuf::from(&worktree_path);
    let gitignore = state.get(&root);

    tokio::task::spawn_blocking(move || {
        let target = if rel_dir.is_empty() {
            root.clone()
        } else {
            root.join(&rel_dir)
        };

        if !target.starts_with(&root) {
            return Err(format!("rel_dir escapes worktree: {}", rel_dir));
        }

        let mut entries: Vec<FsEntry> = Vec::new();
        let walker = WalkBuilder::new(&target)
            .max_depth(Some(1))
            .standard_filters(false)
            .hidden(false)
            .build();

        for dent in walker.filter_map(Result::ok) {
            // Skip the directory itself (max_depth(1) yields the root entry first).
            if dent.path() == target {
                continue;
            }

            let path = dent.path();
            let name = match path.file_name() {
                Some(n) => n.to_string_lossy().into_owned(),
                None => continue,
            };

            // Always exclude .git unconditionally (we never want to surface it,
            // even if the user toggled "show ignored" on).
            if name == ".git" {
                continue;
            }

            let kind = match dent.file_type() {
                Some(ft) if ft.is_dir() => FsKind::Directory,
                Some(ft) if ft.is_symlink() => FsKind::Symlink,
                _ => FsKind::File,
            };

            let relative = path
                .strip_prefix(&root)
                .map_err(|e| format!("strip_prefix: {}", e))?;
            let relative_posix = to_posix(relative);

            let ignored = gitignore
                .matched_path_or_any_parents(relative, kind == FsKind::Directory)
                .is_ignore();

            entries.push(FsEntry {
                name,
                kind,
                relative_path: relative_posix,
                ignored,
            });
        }

        entries.sort_by(|a, b| {
            match (a.kind == FsKind::Directory, b.kind == FsKind::Directory) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
