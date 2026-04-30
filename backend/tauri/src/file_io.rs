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
