# Delta Since Viewed — Show Only New Changes

## Summary

In "All Changes" view, files already marked as "Viewed" currently show the full branch diff. This feature adds a toggle to show only the changes made since the file was last viewed — the delta between the viewed state and the current state.

## Design Decisions

- **Manual toggle, not automatic** — the full diff is shown by default. A button lets you switch to "changes since viewed" mode. This avoids confusion about why a diff looks smaller than expected.
- **Commit hash at view time** — when marking a file as viewed, record the current HEAD commit hash as `viewed_at_commit`. To show the delta later, diff from `viewed_at_commit..HEAD` for that file.
- **Only in "All Changes" mode** — this feature is relevant when reviewing a branch over time. In single-commit mode, the diff is already scoped. In uncommitted mode, the changes are transient.
- **Per-file toggle** — each file independently shows full diff or delta. Not a global mode switch.

## Data Model Changes

### `viewed_files` table

Add `viewed_at_commit` column to the `CREATE TABLE` in `init_db()` (`viewed_files.rs`). Since SQLite's `CREATE TABLE IF NOT EXISTS` won't add columns to existing tables, also run an `ALTER TABLE` that's safe to fail (column already exists):

```rust
conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS viewed_files (
        worktree_path TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        file_path TEXT NOT NULL,
        patch_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        viewed_at_commit TEXT,
        PRIMARY KEY (worktree_path, commit_hash, file_path)
    );
    -- Safe migration for existing tables
    ALTER TABLE viewed_files ADD COLUMN viewed_at_commit TEXT;"
);
// Ignore ALTER error (column already exists)
```

- For new entries: stores the current HEAD commit hash at view time
- For existing entries: `NULL` (no delta available, gracefully degraded)

### Backend: `viewed_files.rs`

- `ViewedFile` struct gains `viewed_at_commit: Option<String>`
- `set_viewed()` gains a new `viewed_at_commit: &str` parameter
- `set_viewed()` upsert includes `viewed_at_commit` in both INSERT and ON CONFLICT DO UPDATE
- `list_viewed()` SELECT query includes the new column
- `row_to_viewed_file` maps the new column

### Frontend: `ViewedFile` type

Add `viewed_at_commit: string | null` to the interface in `viewed-files-provider.ts`.

## Backend Changes

### Updated Tauri command: `set_file_viewed`

In `lib.rs`, update to accept the new parameter:

```rust
#[tauri::command]
fn set_file_viewed(
    state: tauri::State<'_, DbState>,
    worktree_path: String,
    commit_hash: String,
    file_path: String,
    patch_hash: String,
    viewed_at_commit: Option<String>,  // NEW
) -> Result<viewed_files::ViewedFile, String>
```

### New git command: `get_file_diff_since_commit`

In `git.rs`, add a function that diffs a single file from a given commit to HEAD:

```rust
pub fn get_file_diff_since_commit(
    worktree_path: &str,
    since_commit: &str,
    file_path: &str,
) -> Result<String, String>
```

Implementation: `git diff <since_commit>..HEAD -- <file_path>` (double-dot, not triple-dot — we want the direct diff, not merge-base)

### New Tauri command

```rust
#[tauri::command]
fn get_file_diff_since_commit(
    worktree_path: String,
    since_commit: String,
    file_path: String,
) -> Result<String, String>
```

Register in `invoke_handler`.

## Frontend Changes

### `viewed-files-provider.ts`

Update `set()` method to accept and pass `viewedAtCommit`:

```typescript
set(worktreePath, commitHash, filePath, patchHash, viewedAtCommit?)
```

Update `ViewedFile` interface to include `viewed_at_commit: string | null`.

### `toggleViewed` in `DiffView.tsx`

When marking a file as viewed in "all-changes" mode, also pass the worktree's current HEAD commit. Access it via `selectedWorktree.head_commit` which is already available in the component scope:

```typescript
const headCommit = selectedWorktree?.head_commit;
viewedFilesProvider.set(worktreePath, commitHashForViewed, path, patchHash, headCommit);
```

When un-viewing a file, also clear it from `deltaMode` and `deltaDiffs` if present.

### Per-file "Show delta" toggle

In the file header (next to the "Viewed" button), show a small toggle when:
1. The file is marked as viewed
2. The `viewed_at_commit` is recorded (not null)
3. The view mode is "all-changes"
4. The `viewed_at_commit` differs from current HEAD (otherwise delta is empty)

When toggled, fetch the delta diff via the new Tauri command and display it instead of the full branch diff.

### State management

Use local component state in `DiffView.tsx`:
- `deltaMode: Set<string>` — set of file paths currently showing delta view
- `deltaDiffs: Record<string, string>` — cached delta diff text per file

When delta mode is toggled for a file:
1. Call `get_file_diff_since_commit(worktreePath, viewedFile.viewed_at_commit, filePath)`
2. Cache the result in `deltaDiffs`
3. Add the file path to `deltaMode`
4. The diff renderer reads from `deltaDiffs[path]` instead of `fileDiffs[path]`

**Cache invalidation:** Clear `deltaMode` and `deltaDiffs` whenever `fileDiffs` is re-fetched (on commit panel refresh, file system changes, worktree switch). This ensures stale delta diffs are never displayed.

### Visual indicator

Files in delta mode should have a visual cue — e.g., a small label like "since viewed" or a different background tint on the file header, so it's clear this isn't the full diff.

## Edge Cases

- **No `viewed_at_commit` recorded** (legacy viewed entries with NULL): delta toggle is hidden, falls back to current behavior.
- **`viewed_at_commit` no longer exists** (rebased away): the git diff command will fail. Catch the error, show a toast like "Previous view point no longer exists", and hide the delta toggle. The "Viewed" status may also be evicted by the existing stale patch-hash cleanup.
- **File didn't change since viewed**: the delta diff will be empty. Show a message like "No changes since last viewed."
- **File was deleted or renamed since viewed**: git diff handles this naturally, showing the deletion/rename.
- **Re-viewing a file**: the upsert updates both `patch_hash` and `viewed_at_commit` to current values. Delta toggle resets.
- **Un-viewing a file in delta mode**: clear the file from `deltaMode` set and `deltaDiffs` cache.

## What This Does NOT Do

- Does not change the "Viewed" badge behavior — a file is still "Viewed" or not based on patch hash matching.
- Does not affect the annotations system.
- Does not change commit-mode or uncommitted-mode behavior.
