# Task 4: Path-level watcher events + Gitignore caching

**Plan:** File Explorer — Phase 2: Live + Decorated
**Goal:** Replace the file-tree's coarse-event refetch-everything-expanded behaviour with surgical updates: extend the existing `notify`-based watcher to emit a structured `fs-event-${sid}` payload (`{ kind, path, oldPath?, isDirectory }`) alongside the legacy `fs-changed-${sid}`. The hook listens to the structured event and invalidates only the affected parent directory. Cache the per-worktree `Gitignore` matcher so `list_directory` doesn't rebuild it on every call.
**Depends on:** none (does not require Tasks 1-3)

**Files:**
- Modify: `backend/tauri/src/watcher.rs`
- Modify: `backend/tauri/src/file_tree.rs`
- Modify: `backend/tauri/src/lib.rs` — add the new `Gitignore` cache state to `.manage(...)` if needed
- Modify: `apps/desktop/src/hooks/useFileTreeData.ts`

**Background context:**
- The current watcher (`watcher.rs`) emits coarse `fs-changed-${sid}` with a `()` payload after a 2s debounce. It is consumed by:
  - `apps/desktop/src/components/CommitPanel.tsx:213`
  - `apps/desktop/src/hooks/usePrStatusSync.ts:79`
  - `apps/desktop/src/hooks/useFileTreeData.ts:89` (Phase 1)
  We are NOT removing it. We are *adding* a second emission alongside it. Two consumers stay on the coarse signal; the file-tree migrates to structured.
- `notify` `EventKind` variants we need to map: `Create(_)`, `Modify(_)`, `Remove(_)`, `Modify(Name(...))` (rename). The `notify` crate has slightly different rename semantics by platform — on macOS the rename arrives as a `Modify(Name(From))` + `Modify(Name(To))` pair; on Linux as a paired `From` and `To` event. We want one logical `rename` event with both `path` and `oldPath`.
- Overflow signal: when many changes burst in (e.g. `git checkout` of a feature branch flipping thousands of files), `notify` itself rarely overflows in practice — but we add a safety valve. If our debounced emitter sees more than N (say, 200) raw events queued in one window, emit `{ kind: "overflow" }` once and skip per-path emission. Renderer falls back to full refetch.
- The structured event payload should be JSON-serialisable. Use `serde::Serialize` on a small `FsEvent` struct.
- `Gitignore` caching: `build_gitignore` in `file_tree.rs` is called on every `list_directory` request. We move it behind a `Mutex<HashMap<String, CachedGitignore>>` keyed by worktree root. On each call, check the cache; if the worktree's `.gitignore` mtime hasn't changed since the cached entry, reuse. Otherwise rebuild. Use `tauri::State` to thread it through.

**Steps:**

1. **Add a `FsEvent` struct + structured emission in `watcher.rs`.** The current `make_emitter` closure emits `()`. Replace with two emissions: keep `fs-changed-${sid}` with `()` for legacy, add `fs-event-${sid}` with payload.

   Define the struct at the top of `watcher.rs`:

   ```rust
   #[derive(serde::Serialize, Clone, Debug)]
   #[serde(rename_all = "camelCase")]
   pub struct FsEvent {
       pub kind: &'static str, // "create" | "update" | "delete" | "rename" | "overflow"
       pub path: Option<String>,
       pub old_path: Option<String>,
       pub is_directory: Option<bool>,
   }
   ```

   The watcher state today is a per-worktree pair of watchers with a shared debounced emit closure. We restructure to:

   - The notify callback collects `Event`s into a per-worktree `Mutex<Vec<FsEvent>>` queue (a small struct per `WatcherSet`).
   - The debounce thread (already 2s) drains the queue, dedups consecutive identical events for the same path, and emits each as a separate `fs-event-${sid}` Tauri event before also emitting the legacy `fs-changed-${sid}` once.
   - If the queue length at flush exceeds 200, emit a single `FsEvent { kind: "overflow", ... }` instead and skip individual emits.

   Per-event mapping (`notify::EventKind` → `FsEvent.kind`):

   ```rust
   use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
   match event.kind {
       notify::EventKind::Create(_) => /* "create" */,
       notify::EventKind::Modify(ModifyKind::Name(_)) => /* "rename" if From/To paired */,
       notify::EventKind::Modify(_) => /* "update" */,
       notify::EventKind::Remove(_) => /* "delete" */,
       _ => /* skip */,
   }
   ```

   Rename pairing: notify on macOS emits `Modify(Name(Any))` with both old and new paths in `event.paths`. On Linux it emits `Modify(Name(From))` and `Modify(Name(To))` separately, which we have to pair by tracking the most recent `From` per source path. Implementer should consult `notify` docs (<https://docs.rs/notify>) and verify the platform behaviour with a quick test (`mv` a file inside a watched worktree during dev).

   The path stored in the emitted event must be **worktree-relative POSIX**, matching what `list_directory` returns (`relative_path`). Compute by stripping the worktree root prefix and converting to POSIX (use the existing `to_posix` helper from `file_tree.rs`, or copy a small inline equivalent).

   `is_directory` is best-effort: notify doesn't always tell us. Stat the path post-event; if `stat` fails (because the path was deleted), set `is_directory: None` and let the renderer treat the parent generically.

   Existing dominator filters (`/.git/`, `/node_modules/`, etc., `watcher.rs:104-118`) stay in place — we still skip noisy directories.

2. **Add `Gitignore` caching to `file_tree.rs`.** Introduce a Tauri-managed state:

   ```rust
   use std::collections::HashMap;
   use std::sync::Mutex;
   use std::time::SystemTime;

   #[derive(Default)]
   pub struct GitignoreCache {
       inner: Mutex<HashMap<String, (Gitignore, Option<SystemTime>)>>,
   }

   impl GitignoreCache {
       pub fn new() -> Self { Self::default() }

       /// Return a Gitignore matcher for the worktree root, rebuilding if the
       /// `.gitignore` mtime changed since the cached entry.
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
   ```

   Update `list_directory` to take `state: tauri::State<'_, GitignoreCache>` and use `state.get(&root)` instead of the unconditional `build_gitignore(&root)` call.

   In `lib.rs` `build()` chain, `.manage(GitignoreCache::new())` next to other `.manage(...)` calls.

3. **Update `useFileTreeData.ts` to consume `fs-event-${sid}`.** Replace the existing coarse-event listener (lines 89-92 area) with a structured listener:

   ```ts
   const eventName = `fs-event-${sanitizeEventId(worktreePath)}`;
   unlisten = await listen<FsEventPayload>(eventName, (e) => {
     handleFsEvent(e.payload);
   });
   ```

   Where `FsEventPayload`:

   ```ts
   interface FsEventPayload {
     kind: "create" | "update" | "delete" | "rename" | "overflow";
     path: string | null;
     oldPath: string | null;
     isDirectory: boolean | null;
   }
   ```

   Handler logic (sketch):

   ```ts
   function handleFsEvent(ev: FsEventPayload) {
     if (ev.kind === "overflow") {
       void refetchAll();
       return;
     }
     // Determine the parent dir to invalidate. For create/update/delete: parent of `path`.
     // For rename: parents of both `oldPath` and `path` (might differ).
     const parents = new Set<string>();
     if (ev.path) parents.add(parentDirOf(ev.path));
     if (ev.oldPath) parents.add(parentDirOf(ev.oldPath));

     // For directory rename, also retarget any entries in expandedDirsRef under the old prefix.
     if (ev.kind === "rename" && ev.isDirectory && ev.oldPath && ev.path) {
       retargetExpanded(ev.oldPath, ev.path);
     }

     // Refetch each affected parent (only if currently loaded — i.e. tracked
     // in childrenByDirRef OR equal to the root).
     for (const parent of parents) {
       if (childrenByDirRef.current.has(parent)) {
         void fetchDir(parent).then(() => recomputePaths());
       }
     }
   }

   function parentDirOf(path: string): string {
     const slash = path.lastIndexOf("/");
     return slash === -1 ? "" : path.slice(0, slash);
   }
   ```

   Concurrency: each `fetchDir` is already epoch-guarded. Multiple in-flight fetches can race; the one that finishes last wins for its parent dir. Acceptable.

4. **Type-check + Cargo build.**

   ```bash
   cd backend/tauri && cargo check
   cd apps/desktop && bun run typecheck
   ```

5. **Smoke test.** Run `bun run dev`. Open the Files tab.

   - From a separate terminal, create a file: `touch <worktree>/apps/desktop/src/foo.txt`. The tree should add `foo.txt` under `apps/desktop/src/` within ~2 seconds (debounce). Other expanded directories should NOT have been re-fetched (verify by adding a `console.log` in `fetchDir` and watching the count of calls).
   - Delete the file: `rm <worktree>/apps/desktop/src/foo.txt`. It should disappear.
   - Rename a file: `mv <worktree>/apps/desktop/src/foo.txt <worktree>/apps/desktop/src/bar.txt`. The tree should reflect the rename.
   - Rename a directory: `mv <worktree>/temp-dir <worktree>/temp-dir-renamed`. The tree should reflect both the deletion and the new directory.
   - Bulk: `git checkout <feature-branch>` on a branch that flips many files. The renderer should NOT re-fetch every expanded directory hundreds of times — overflow should fire and a single `refetchAll` should run.

6. **Commit:**

   ```bash
   git add backend/tauri/src/watcher.rs backend/tauri/src/file_tree.rs backend/tauri/src/lib.rs apps/desktop/src/hooks/useFileTreeData.ts
   git commit -m "feat(file-tree): path-level watcher events + cached Gitignore"
   ```

**Done When:**

- [ ] `watcher.rs` emits `fs-event-${sid}` with structured `{ kind, path, oldPath, isDirectory }` payload alongside the existing `fs-changed-${sid}`
- [ ] Rename pairing produces a single `kind: "rename"` event with both `path` and `oldPath`
- [ ] Overflow path fires when the per-window event count exceeds the threshold
- [ ] `GitignoreCache` is wired through `tauri::State` and used by `list_directory`
- [ ] `useFileTreeData` subscribes to `fs-event-${sid}`, surgically refetches affected parents, retargets expanded paths on directory rename, falls back to `refetchAll` on overflow
- [ ] Existing `fs-changed-${sid}` consumers (`CommitPanel`, `usePrStatusSync`) still work
- [ ] `cargo check` + `bun run typecheck` both clean
- [ ] Smoke verified: create / update / delete / rename file, rename directory, bulk-checkout overflow
- [ ] Changes committed
