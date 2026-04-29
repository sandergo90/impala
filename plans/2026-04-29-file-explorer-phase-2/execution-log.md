# Execution Log: File Explorer — Phase 2

**Started:** 2026-04-29
**Completed:** 2026-04-29
**Plan:** plans/2026-04-29-file-explorer-phase-2/

## Tasks

| # | Name | Classification | Status | Reviewer | Fixes |
|---|------|---------------|--------|----------|-------|
| 1 | Git status + ignored decoration + built-in icons | moderate | DONE | Approved (advisory note on dead-code recursion in mapGitStatus) | none |
| 2 | Image / binary / large-file handling in FileViewer | moderate | DONE | 1 round | Tailwind v4 `var(--color-muted)` (was `theme(colors.muted)`) |
| 3 | Persistence (expanded folders + selectedFilePath) | moderate | DONE | Approved (acknowledged macOS "deleted dir survives prune" edge — naturally handled by Task 4) | none |
| 4 | Path-level watcher events + Gitignore caching | complex | DONE (with design divergence) | Approved | macOS rename pairing impossible per FSEvents — accepted Option 1: emit delete+create on macOS, keep paired `rename` for Linux only |
| `simplify` | Reuse / quality / efficiency pass | — | DONE | — | Add missing `protocol-asset` Cargo feature (Task 2 missed staging it!), `FsEvent.kind` → `FsEventKind` enum, `HashMap`-as-`HashSet` → real `HashSet`, drop debounce-flag guard before `thread::spawn`, skip parent refetch on file-content `update` events, drop redundant `?? ""` fallback. |

## Commits (newest first)

- `7e58cbf` refactor(file-tree): simplify Phase 2 watcher + hook
- `566f4ca` feat(file-tree): path-level watcher events + cached Gitignore
- `4937a51` feat(file-tree): persist expanded folders and selected file across restarts
- `1f5addb` fix(file-tree): use Tailwind v4 CSS variable for checker backdrop
- `9c93bf3` feat(file-tree): handle images, binaries, large files in viewer
- `1623c27` feat(file-tree): git status decoration + built-in icons

## Files Changed

- `backend/tauri/src/watcher.rs` — structured `FsEvent` emission, queue-based flush, rename pairing, overflow guard
- `backend/tauri/src/file_tree.rs` — `GitignoreCache` with mtime-keyed invalidation
- `backend/tauri/src/lib.rs` — `.manage(GitignoreCache::new())`
- `backend/tauri/Cargo.toml` — `tauri = { features = ["protocol-asset", "image-png"] }`
- `backend/tauri/Cargo.lock` — `http-range` from the new feature
- `backend/tauri/tauri.conf.json` — `app.security.assetProtocol = { enable: true, scope: ["**"] }`
- `apps/desktop/src/lib/git-status.ts` (new) — porcelain → `GitStatus` mapper
- `apps/desktop/src/lib/file-kind.ts` (new) — `classifyFile`, `formatBytes`, `TEXT_SIZE_CAP_BYTES`
- `apps/desktop/src/hooks/useFileTreeData.ts` — `entriesByPath` consolidation, `fs-event-${sid}` consumer, persistence hydrate + prune, `update` short-circuit
- `apps/desktop/src/components/FilesPanel.tsx` — `setGitStatus` + built-in icons
- `apps/desktop/src/components/FileViewer.tsx` — kind-dispatched rendering (image/svg/binary/large-text/text)
- `apps/desktop/src/store.ts` — `worktreeExpandedDirs` slice (auto-persisted via inverted partialize)

## Design Divergences from Phase 2 Plan

1. **Iconify dropped.** Plan called for `@iconify/react` + `@iconify-json/material-icon-theme`. While reading the trees-package types we found it ships built-in icon sets (`'minimal' | 'standard' | 'complete'`) with per-extension/basename remap. Used `icons: { set: 'standard', colored: true }` instead — saves a dep and registration boilerplate. If the look isn't right, swap to Iconify in a follow-up.

2. **`ignoredMap` consolidated into `setGitStatus`.** Trees' `GitStatus` enum already includes `'ignored'`. One API now carries both changed-file decoration and ignored-row dimming. Phase 1's `ignoredMap` return removed; replaced by per-file `entriesByPath` in `useFileTreeData`.

3. **macOS rename pairing — Option 1 (accept platform reality).** `notify` 8.2's source explicitly states FSEvents has no mechanism to associate the old + new sides of a rename. Plan assumed otherwise. After surfacing to the user, they approved emitting `delete`+`create` separately on macOS (Linux still gets paired `rename` events via `RenameMode::Both`). The directory-rename retarget code path remains but is dead code on macOS; macOS self-heals on the next `refetchAll` prune. Documented inline in both `watcher.rs` and `useFileTreeData.ts`.

4. **`worktreeExpandedDirs` auto-persists via inverted partialize.** Plan asked to add the field to a persist allowlist. The existing `useUIStore` partialize is INVERTED — destructures excluded keys, returns `rest` — so the new field is automatically persisted. No partialize change needed.

5. **`tauri::State<'_, GitignoreCache>` resolved before `spawn_blocking`.** The State guard isn't `Send`; clone the matcher into the closure before entering the blocking task.

## Test Results

- `cd backend/tauri && cargo check` — clean (no warnings)
- `cd apps/desktop && bun run typecheck` — clean
- No automated test suite in the project (per CLAUDE.md the standard verification is typecheck + cargo check)
- End-to-end smoke deferred to the human: open the Files tab, verify git status colors, file icons, image/binary preview, large-file gate, expanded-state persistence across restart, fs-event reactivity (touch/rm/mv files in terminal and watch tree update)

## Known Edge Cases Carried Forward to Phase 3

- **Deleted directory survives `expandedDirsRef` prune** when its `list_directory` returns `Ok(vec![])` instead of erroring (the WalkBuilder swallows missing-path errors). Phase 2 Task 4's path-level `delete` events fix this in the common case (deletion received → parent refetched → directory disappears from validDirs); persistent state still requires worktree switch to clear.
- **`gitStatusEntries` rebuild iterates all `entriesByPath` on every fs-event.** Phase 2 acceptable; Phase 3 should maintain `ignoredPaths: Set<string>` incrementally if profiling shows hot-path cost.
- **`app.emit` per-event in busy windows.** Each translated FsEvent costs one IPC emit. For bursts approaching the 200-event overflow threshold, this is ~200 separate emits. Phase 3 follow-up: batch into a single `app.emit("fs-event-...", &Vec<FsEvent>)` so the renderer processes events in one React batch.
- **Two IPC calls per file selection (`stat` + `readTextFile`).** Acceptable trade-off for large-file safety. Phase 3 could expose a single `read_file_with_stat` Rust command.
- **Nested `.gitignore` files are not mtime-tracked by `GitignoreCache`.** The cache only watches the worktree-root `.gitignore`. If users edit nested gitignores, the cached matcher goes stale. No regression vs Phase 1; flagged for awareness.
- **Debounce thread loop is duplicated** between worktree + refs branches in `watcher.rs`, and a third copy lives in `plan_scanner.rs`. Worth extracting a shared `spawn_debounce_emitter` helper if any of these are touched again.
- **`to_posix` is duplicated** between `watcher.rs` and `file_tree.rs` (identical implementations). Worth extracting to a shared `path_utils` module on next touch.

## Phase 2 Done When (verification)

- ✅ Tree rows decorated with git status + ignored dimming + file-type icons
- ✅ Viewer handles images, binaries, SVG (with source toggle), large text (with override)
- ✅ Asset protocol enabled in `tauri.conf.json` AND `protocol-asset` Cargo feature on
- ✅ Expanded folders + last-open file survive app restart; stale paths pruned on rehydrate
- ✅ Watcher emits structured `fs-event-${sid}` with surgical parent invalidation; legacy `fs-changed-${sid}` preserved for `CommitPanel` / `usePrStatusSync`
- ✅ Overflow guard (>200 events) falls back to full refetch
- ✅ Per-worktree `Gitignore` cached in Rust state, mtime-invalidated
- ✅ Both verification commands clean (`cargo check`, `bun run typecheck`)
- ✅ All work committed (6 commits including the simplify pass)
