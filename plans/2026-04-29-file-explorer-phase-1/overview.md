# File Explorer — Phase 1: Walking Skeleton

> **For Claude:** REQUIRED SUB-SKILL: Use implement-plans to execute this plan.

**Goal:** Ship the thinnest end-to-end "browse your worktree, click a file, see its contents" inside Impala. Validates the Rust↔React pipe before adding decorations, watcher integration, tabs, or search.

**Architecture:**
- **Rust:** New `file_tree` module exposes `list_directory(worktree_path, rel_dir)` that returns one directory's children using the `ignore` crate (`standard_filters(false)`, `max_depth(1)`), tagging each entry with `ignored: bool` via a `Gitignore` matcher. `.git` is the only path skipped unconditionally.
- **React:** New `Files` tab in `RightSidebar` (before `Changes`/`Annotations`). Tree uses `@pierre/trees/react` (`useFileTree` + `<FileTree>`). Lazy expansion: root is fetched on tab activation; `model.add()` injects children when a folder is expanded.
- **Viewer:** New `"files"` mode in `MainView`'s existing static tab bar (next to `Terminal` / `Diff` / `Split` / `Plan`). Renders `<File>` from `@pierre/diffs/react` for the currently-selected path. Single slot — no preview/pin, no multi-tab. Reading file contents goes through `@tauri-apps/plugin-fs` (already a dep).
- **Freshness (deferred):** Phase 1 listens to the existing coarse `fs-changed-${sanitized}` event and re-fetches root + every currently-expanded directory, calling `resetPaths()` on the model. Path-level events come in Phase 2.

**Tech Stack:** Tauri 2 + Rust (`ignore` crate), React 19, `@pierre/trees`, `@pierre/diffs` (already installed), Tailwind v4, Zustand.

**Phase:** Phase 1 of 3 — Walking skeleton

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Walking skeleton: see tree, click file, see contents | Current |
| 2 | Live + decorated: watcher path-events, git status, icons, persistence, non-text handling | Planned |
| 3 | Power-user navigation: preview/pin tabs, in-tree search, Cmd+P palette, reveal-in-files, selection sync | Planned |

## Out of Scope (Phase 1)

- Iconify icons / file-type icons (Phase 2)
- Git status decoration on rows (Phase 2)
- Persistence of expanded folders (Phase 2)
- Image / binary / large-file handling — Phase 1 only opens text files; non-text shows raw text or breaks (acceptable for skeleton) (Phase 2)
- Path-level watcher events / parent-dir invalidation (Phase 2)
- Preview/pin tab semantics (Phase 3)
- In-tree search (Phase 3)
- Cmd+P palette (Phase 3)
- Reveal-in-files context menu (Phase 3)
- File operations (create/rename/delete/move/copy) — out of scope entirely

## Tasks

| # | Name | Dependencies | Files |
|---|------|--------------|-------|
| 1 | Rust `list_directory` command | none | `backend/tauri/src/file_tree.rs` (new), `backend/tauri/src/lib.rs`, `backend/tauri/Cargo.toml` |
| 2 | Files tab in RightSidebar with `@pierre/trees` | Task 1 | `apps/desktop/package.json`, `apps/desktop/src/components/FilesPanel.tsx` (new), `apps/desktop/src/hooks/useFileTreeData.ts` (new), `apps/desktop/src/components/RightSidebar.tsx`, `apps/desktop/src/store.ts` |
| 3 | File viewer mode in MainView | Task 2 | `apps/desktop/src/components/FileViewer.tsx` (new), `apps/desktop/src/views/MainView.tsx`, `apps/desktop/src/types.ts` |
