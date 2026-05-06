use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

/// Per-process monotonic counter so concurrent writes to the same path
/// (e.g. two rapid Cmd+S presses, or two windows saving the same file)
/// land on distinct temp files instead of clobbering each other.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Opaque revision token: `<mtime_nanos>-<size_bytes>`. Stable enough for an
/// editor session — if the file is rewritten with the same mtime AND same
/// size we'll miss it, which is acceptable for an MVP. Stored as String on
/// the wire so the frontend treats it opaquely.
fn revision_for_path(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("stat failed: {e}"))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("mtime unavailable: {e}"))?;
    let nanos = mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(format!("{nanos}-{}", meta.len()))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileWithRevision {
    pub content: String,
    pub revision: String,
}

#[tauri::command]
pub fn read_file_with_revision(absolute_path: String) -> Result<ReadFileWithRevision, String> {
    let path = Path::new(&absolute_path);
    let revision = revision_for_path(path)?;
    let content = fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;
    Ok(ReadFileWithRevision { content, revision })
}

/// File size in bytes. Used by the file viewer to decide whether to render
/// a preview or the "load anyway" placeholder for >1 MB text files. Plain
/// `std::fs::metadata` so we don't go through `@tauri-apps/plugin-fs`'s
/// scope rules, which trip over nested dotfiles like `.venv/.gitignore`.
#[tauri::command]
pub fn stat_file_size(absolute_path: String) -> Result<u64, String> {
    let meta = fs::metadata(Path::new(&absolute_path))
        .map_err(|e| format!("stat failed: {e}"))?;
    Ok(meta.len())
}

/// Tagged-union wire shape: `{ kind: "ok", revision }` or
/// `{ kind: "conflict", currentRevision }`. The frontend discriminates on
/// `result.kind`.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteFileResult {
    Ok {
        revision: String,
    },
    Conflict {
        current_revision: Option<String>,
    },
}

/// Write atomically iff the file's current revision matches `if_match`.
/// `if_match: None` means "create or overwrite unconditionally" (used for
/// brand-new files that have never been read). On conflict we return the
/// current revision so the caller can re-fetch disk content and surface a
/// resolution UI without a second roundtrip just to learn the new revision.
#[tauri::command]
pub fn write_file_with_precondition(
    absolute_path: String,
    content: String,
    if_match: Option<String>,
) -> Result<WriteFileResult, String> {
    let path = Path::new(&absolute_path);

    if let Some(expected) = if_match.as_ref() {
        match fs::metadata(path) {
            Ok(_) => {
                let current = revision_for_path(path)?;
                if &current != expected {
                    return Ok(WriteFileResult::Conflict {
                        current_revision: Some(current),
                    });
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WriteFileResult::Conflict {
                    current_revision: None,
                });
            }
            Err(e) => return Err(format!("stat failed: {e}")),
        }
    }

    let parent = path
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let tmp_name = format!(
        ".{}.impala-tmp-{}-{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "out".to_string()),
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let tmp_path = parent.join(&tmp_name);

    {
        let mut f = fs::File::create(&tmp_path).map_err(|e| format!("create temp failed: {e}"))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("write temp failed: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync temp failed: {e}"))?;
    }

    fs::rename(&tmp_path, path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("rename failed: {e}")
    })?;

    let revision = revision_for_path(path)?;
    Ok(WriteFileResult::Ok { revision })
}

/// Create an empty file. Errors if the path already exists. The parent
/// directory must already exist; we do not auto-mkdir.
#[tauri::command]
pub fn fs_create_file(absolute_path: String) -> Result<(), String> {
    let path = Path::new(&absolute_path);
    if path.exists() {
        return Err(format!("{absolute_path} already exists"));
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("create failed: {e}"))?;
    Ok(())
}

/// Create a directory and any missing parents. Errors if the leaf already
/// exists as a file (mkdir -p semantics: re-creating an existing dir is OK).
#[tauri::command]
pub fn fs_create_directory(absolute_path: String) -> Result<(), String> {
    let path = Path::new(&absolute_path);
    if path.is_file() {
        return Err(format!("{absolute_path} already exists as a file"));
    }
    fs::create_dir_all(path).map_err(|e| format!("mkdir failed: {e}"))?;
    Ok(())
}

/// Rename / move a path. Errors if the destination already exists so we
/// don't silently clobber a file the user didn't mean to overwrite.
#[tauri::command]
pub fn fs_rename(from_absolute: String, to_absolute: String) -> Result<(), String> {
    let from = Path::new(&from_absolute);
    let to = Path::new(&to_absolute);
    if !from.exists() {
        return Err(format!("source does not exist: {from_absolute}"));
    }
    if to.exists() {
        return Err(format!("destination already exists: {to_absolute}"));
    }
    fs::rename(from, to).map_err(|e| format!("rename failed: {e}"))?;
    Ok(())
}

/// Delete a file or directory. Directories are removed recursively.
#[tauri::command]
pub fn fs_delete(absolute_path: String) -> Result<(), String> {
    let path = Path::new(&absolute_path);
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("stat failed: {e}")),
    };
    let result = if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|e| format!("delete failed: {e}"))
}
