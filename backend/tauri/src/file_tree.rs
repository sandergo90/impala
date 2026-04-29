use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};

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

#[tauri::command]
pub async fn list_directory(
    worktree_path: String,
    rel_dir: String,
) -> Result<Vec<FsEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&worktree_path);
        let target = if rel_dir.is_empty() {
            root.clone()
        } else {
            root.join(&rel_dir)
        };

        if !target.starts_with(&root) {
            return Err(format!("rel_dir escapes worktree: {}", rel_dir));
        }

        let gitignore = build_gitignore(&root);

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
