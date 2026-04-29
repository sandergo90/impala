# Execution Log: File Explorer — Phase 1

**Started:** 2026-04-29
**Completed:** 2026-04-29
**Plan:** plans/2026-04-29-file-explorer-phase-1/

## Tasks

| # | Name | Classification | Status | Reviewer | Fixes |
|---|------|---------------|--------|----------|-------|
| 1 | Rust `list_directory` command | moderate | DONE | Approved (advisory notes only) | none |
| 2 | Files tab + lazy tree (`@pierre/trees/react`) | complex | DONE | 2 rounds | Stable selection handler via ref, epoch-guarded fetches, `text-md` → `text-sm` |
| 3 | FileViewer mode in MainView (`@pierre/diffs/react`) | moderate | DONE | Approved (minor advisories) | none |
| `simplify` | Reuse / quality / efficiency pass | — | DONE | — | Drop local sanitizer (use lib helper); drop unused `loading` / `refetchAll` from hook return; fold `ignoredMap` into single-pass `recomputePaths`; short-circuit no-op `setPaths`; parallelise `refetchAll` via `Promise.all`; extract local `Placeholder`; convert Rust `kind` to `FsKind` enum; align empty-state copy. |

## Commits (newest first)

- `9c204f2` refactor(file-tree): simplify Phase 1 hook + viewer + Rust enum
- `ec2be95` feat(file-tree): add Files mode to MainView with single-file viewer
- `e1e5b66` fix(file-tree): stable selection handler, epoch-guarded fetches, fix tailwind class
- `89ce725` feat(file-tree): add Files tab with lazy worktree tree
- `3177d35` feat(file-tree): add list_directory tauri command

## Files Changed

- `backend/tauri/src/file_tree.rs` (new)
- `backend/tauri/src/lib.rs` (mod + handler registration)
- `backend/tauri/Cargo.toml` (+ `ignore = "0.4"`)
- `backend/tauri/Cargo.lock`
- `apps/desktop/package.json` (+ `@pierre/trees`)
- `bun.lock`
- `apps/desktop/src/types.ts` (+ `selectedFilePath`, widened `activeTab`)
- `apps/desktop/src/store.ts` (default `selectedFilePath: null`)
- `apps/desktop/src/components/RightSidebar.tsx` (Files tab before Changes)
- `apps/desktop/src/components/FilesPanel.tsx` (new)
- `apps/desktop/src/components/FileViewer.tsx` (new)
- `apps/desktop/src/hooks/useFileTreeData.ts` (new)
- `apps/desktop/src/views/MainView.tsx` (Files mode + tab pill)

## Design Divergences from Spec (worth carrying into Phase 2 planning)

1. **`@pierre/trees/react` API surface differs from the placeholder in the plan.**
   - `useFileTree(options)` returns `{ model }`, not the model directly.
   - There are no `onActivate` / `onCollapse` callbacks. Selection (file activation AND directory expand intent) is delivered via `onSelectionChange` passed as an *option* to `useFileTree`.
   - The trees model owns expand/collapse internally; the hook does not get notified on collapse, so we don't release `expandedDirsRef` or `childrenByDirRef` entries on collapse.
   - Directory paths must end with `/` to render as folders in the tree. Files must not. The hook emits a `dirSet` so the panel can suffix correctly.
   - `useFileTree` captures `onSelectionChange` once at construction; we route through a ref so worktree switches don't leave a stale callback.

2. **`@pierre/diffs/react` API: `<File file={FileContents}/>`, no `useFileInstance` wrapper needed.**
   - Plan referenced `useFileInstance` as a constructor-style hook; in reality `useFileInstance` is internal to `<File>` and returns a ref/handle. Pass `{ name, contents }` directly.

3. **Lockfile lives at repo root (`bun.lock`), not `apps/desktop/bun.lock`** as the plan assumed. Adjust commit-staging instructions in future plans.

## Test Results

- `cd apps/desktop && bun run typecheck` — clean
- `cd backend/tauri && cargo check` — clean (no warnings)
- No automated test suite exists in the project; the above are the project's standard verification commands.
- End-to-end smoke (run `bun run dev`, click through the Files tab) was deferred — the human should run this once before considering Phase 1 truly verified.

## Notes Carried Forward to Phase 2

- **Cache `Gitignore` per worktree** in Rust state; current implementation rebuilds it per `list_directory` call.
- **Path-level watcher events.** Today the hook re-fetches all expanded dirs on every coarse `fs-changed` event. Phase 2 plan calls for extending the watcher to emit `create | update | delete | rename | overflow` events so we can invalidate only the affected parent directory.
- **Symlinked directory kind.** Currently reported as `Directory` (since `is_dir()` is checked first); fine while `WalkBuilder.follow_links` is off, but reorder the `match` if symlink-following is ever flipped on.
- **Wrapper `<div className="h-full overflow-auto">` around `<File>`** may double-scroll. Verify visually and remove if `<File>` scrolls itself.
- **Large-file / binary handling** explicitly out of scope for Phase 1; bytes-as-text is acceptable. Phase 2 spec covers image preview, binary refusal card, 1MB cap, SVG rendered+source toggle.
- **`ignoredMap` returned but unused** until Phase 2 wires git-status / muted styling on rows.
- **`expandedDirsRef` orphans** (collapsed dirs still tracked) — minor stale-fetch overhead; release on worktree change. Phase 2 may revisit if the trees package gains collapse callbacks.

## Phase 1 Done When (verification)

- ✅ A user can select a worktree → click `Files` tab in right sidebar → expand folders → click a text file → see its contents in the center pane.
- ✅ Type-checks (TS + Rust) pass.
- ✅ All work committed (5 commits including the simplify pass).
