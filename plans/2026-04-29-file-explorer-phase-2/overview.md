# File Explorer — Phase 2: Live + Decorated

> **For Claude:** REQUIRED SUB-SKILL: Use implement-plans to execute this plan.

**Goal:** Make the Phase 1 file explorer feel finished: rows are decorated with git status / ignored dimming / file-type icons, the viewer handles non-text files cleanly, expanded folders + last-open file survive an app restart, and the watcher emits granular events so the tree refresh is incremental rather than a coarse re-walk.

**Architecture:**
- **Decorations & icons (Task 1):** Switch from a separately-returned `ignoredMap` to one consolidated `setGitStatus()` call on the trees model that carries both `changedFiles` mappings AND the ignored-entries flag (the trees package's `GitStatus` enum already includes `'ignored'`). Use the trees package's built-in `'standard'` icon set with `colored: true` — no third-party Iconify dep needed.
- **Non-text handling (Task 2):** Detect file kind by extension; image extensions render via `<img src={convertFileSrc(...)} />`, binary refusal card with size + open-in-editor, 1MB text cap with "load anyway" override, SVG renders rendered with a source toggle. Use `@tauri-apps/plugin-fs`'s `stat()` for the size check; no new Rust command needed.
- **Persistence (Task 3):** Add `worktreeExpandedDirs: Record<string, string[]>` to `useUIStore`'s persisted slice, hydrated into `useFileTreeData`'s expanded set on worktree change. Include `selectedFilePath` in the persist allowlist on `worktreeNavStates`. Drop unknown paths on rehydrate (file deleted between sessions).
- **Path-level watcher events + Gitignore caching (Task 4):** Extend `backend/tauri/src/watcher.rs` to emit a NEW structured event `fs-event-${sid}` with a `{ kind, path, oldPath?, isDirectory }` payload, where `kind ∈ { create, update, delete, rename, overflow }`. **Keep the existing coarse `fs-changed-${sid}` event emitting** — `CommitPanel.tsx` and `usePrStatusSync.ts` consume it; do not break them. Cache `Gitignore` per worktree in a `Mutex<HashMap<...>>` Tauri state, invalidated on `.gitignore` mtime change. React side: `useFileTreeData` swaps from coarse `fs-changed-` to structured `fs-event-`, invalidates only the affected parent dir, retargets expanded set on rename, falls back to full refetch on overflow.

**Tech Stack:** Same as Phase 1. Adds nothing on the JS side. Adds an LRU-friendly `Mutex<HashMap>` on the Rust side for Gitignore caching.

**Phase:** Phase 2 of 3 — Live + Decorated

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Walking skeleton: see tree, click file, see contents | Done |
| 2 | Live + decorated: status, icons, viewer polish, persistence, granular watcher | Current |
| 3 | Power-user navigation: preview/pin tabs, in-tree search, Cmd+P palette, reveal-in-files, selection sync | Planned |

## Notable Reframings vs the Original Phase 2 Sketch

- **No Iconify dep.** Phase 1 design said "Iconify + `@iconify-json/material-icon-theme`, registered locally." After reading `node_modules/@pierre/trees/dist/iconConfig.d.ts`, the trees package ships built-in icon sets with per-extension/per-basename remap support. We use `icons: { set: 'standard', colored: true }`. If the look is wrong after Task 1 ships, swap to Iconify in a follow-up.
- **No separate `ignoredMap`.** `GitStatus` in `@pierre/trees` includes `'ignored'`. We feed all decoration through one `setGitStatus()` call. Phase 1's `ignoredMap` return from `useFileTreeData` gets dropped in Task 1.
- **Emit a NEW event, don't replace.** Existing consumers (`CommitPanel.tsx:213`, `usePrStatusSync.ts:79`) still use coarse `fs-changed-`. Task 4 adds `fs-event-` and migrates `useFileTreeData` to the new event; the legacy event keeps emitting for its current consumers.

## Out of Scope (Phase 2)

- Preview/pin tab semantics (Phase 3)
- In-tree search (Phase 3)
- Cmd+P global file finder (Phase 3)
- Reveal-in-files context menu (Phase 3)
- Two-way tree↔tab selection sync (Phase 3)
- File operations (create/rename/delete/move/copy) — out of scope entirely
- LSP / code intelligence — out of scope entirely

## Tasks

| # | Name | Dependencies | Files |
|---|------|--------------|-------|
| 1 | Git status + ignored decoration + built-in icons | none | `apps/desktop/src/hooks/useFileTreeData.ts`, `apps/desktop/src/components/FilesPanel.tsx`, `apps/desktop/src/lib/git-status.ts` (new) |
| 2 | Image / binary / large-file handling in FileViewer | none | `apps/desktop/src/components/FileViewer.tsx`, `apps/desktop/src/lib/file-kind.ts` (new) |
| 3 | Persistence (expanded folders + selected file) | Task 1 | `apps/desktop/src/store.ts`, `apps/desktop/src/hooks/useFileTreeData.ts`, `apps/desktop/src/components/FilesPanel.tsx` |
| 4 | Path-level watcher events + Gitignore caching | none | `backend/tauri/src/watcher.rs`, `backend/tauri/src/file_tree.rs`, `backend/tauri/src/lib.rs`, `apps/desktop/src/hooks/useFileTreeData.ts` |

Tasks 1, 2, and 4 are independent and can run in any order. Task 3 depends on Task 1 only because Task 1 touches the same hook surface. Implementer should follow numerical order for the smallest merge surface.
