# File Explorer — Phase 3: Power-user Navigation

> **For Claude:** REQUIRED SUB-SKILL: Use implement-plans to execute this plan.

**Goal:** Move the file viewer from a single MainView slot into VS-Code-style preview/pin tabs in the dynamic tab bar (alongside agent/terminal). Add in-tree filtering, a Cmd+P global file finder, "Reveal in Files" cross-references from the diff view, and two-way selection sync between the tree and active tab.

**Architecture:**
- **Preview/pin tabs (Task 1):** Extend `UserTab.kind` to `"terminal" | "agent" | "file"`. File tabs carry `{ path: string, pinned: boolean }`. Click a file in the tree → reuse-or-create the single preview tab (`pinned: false`); double-click → flip the same tab to `pinned: true`. Subsequent clicks while a preview tab exists *replace* its `path`. Remove the old `"files"` `activeTab` value from `WorktreeNavState["activeTab"]` — files now ride the dynamic tab system.
- **In-tree search (Task 2):** Add a debounced search input at the top of the Files panel. Drives `model.setSearch(value)` on `@pierre/trees`'s built-in search (uses `'expand-matches'` mode). `Cmd+F` while the Files tab is focused opens the search input.
- **Cmd+P file finder (Task 3):** New Rust `list_all_files(worktree_path) -> Vec<String>` doing a full `ignore::WalkBuilder` walk (no max_depth, `standard_filters(false)`, hidden(false)). Cached per-worktree, invalidated on the structured `fs-event-${sid}` create/delete/rename payloads. New `FileFinder.tsx` (separate cmdk palette, distinct from the existing `CommandPalette`) with `fzf-for-js` ranking. Empty state shows recently-opened files derived from current `userTabs` of kind `"file"` plus the persisted `selectedFilePath`s. Enter opens as preview tab; Cmd+Enter pins.
- **Reveal-in-files + selection sync (Task 4):** Right-click context menu on `CommitPanel`'s and `DiffView`'s changed-file rows → "Reveal in Files". Switches the right sidebar to the Files tab, expands all ancestors via the existing `expand` hook surface, and writes the selection through the trees model. Two-way sync: selecting a tab makes the tree highlight that file (via `useFileTreeSelection` or a manual selection writer); selecting a tree row updates/creates the preview tab. `OpenInEditorButton` + a new `RevealInFinderButton` land on the file viewer header.

**Tech Stack:** Same as Phase 2 plus `fzf-for-js` (~10KB).

**Phase:** Phase 3 of 3 — Power-user navigation

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Walking skeleton: see tree, click file, see contents | Done |
| 2 | Live + decorated: status, icons, viewer polish, persistence, granular watcher | Done |
| 3 | Power-user navigation: preview/pin tabs, in-tree search, Cmd+P palette, reveal-in-files, selection sync | Current |

## Notable Reframings vs the Original Phase 3 Sketch

- **Trees package's `useFileTreeSearch` hook + model `setSearch()` are the API**, not `setSearchQuery({ mode: ... })` as the Phase 1 design conversation casually wrote. Search mode is set at model construction via `fileTreeSearchMode: 'expand-matches'`.
- **No new `activeTab: "files"` mode in MainView.** Task 1 *removes* the existing `"files"` mode and routes file viewing through the existing dynamic tab system (`createUserTab`-style). The Files *sidebar tab* (right rail) is unaffected; only the center pane changes.
- **`fzf-for-js`** for fuzzy ranking. Confirmed not currently a dep; ~10KB; path-aware scoring.
- **`useFileTreeSelection` hook** exists in the package — use it for tree-side selection observation rather than reading from a callback.
- **The `userTabPaneId` infrastructure assumes PTY sessions.** File tabs don't need a PTY; the implementer must verify the pane-id paths don't try to spin up a shell for `kind: "file"` tabs.

## Out of Scope (Phase 3 / overall)

- File operations (create/rename/delete/move/copy) — out of scope for the feature
- LSP / code intelligence — separate follow-up ticket
- Notebook/CSV/rendered-markdown viewers — explicit non-goal

## Tasks

| # | Name | Dependencies | Files |
|---|------|--------------|-------|
| 1 | Preview/pin file tabs (replace MainView "files" mode) | none | `apps/desktop/src/types.ts`, `apps/desktop/src/lib/tab-actions.ts`, `apps/desktop/src/components/FilesPanel.tsx`, `apps/desktop/src/views/MainView.tsx`, `apps/desktop/src/components/RightSidebar.tsx`, plus removal of the now-unused `"files"` activeTab branch |
| 2 | In-tree search | Task 1 | `apps/desktop/src/components/FilesPanel.tsx`, `apps/desktop/src/components/FileSearchInput.tsx` (new) |
| 3 | Cmd+P file finder palette | Task 1 | `backend/tauri/src/file_tree.rs`, `backend/tauri/src/lib.rs`, `apps/desktop/package.json` (+`fzf-for-js`), `apps/desktop/src/components/FileFinder.tsx` (new), `apps/desktop/src/hooks/useAllFiles.ts` (new), hotkey wiring |
| 4 | Reveal-in-files + selection sync + viewer header | Tasks 1, 2 | `apps/desktop/src/components/CommitPanel.tsx`, `apps/desktop/src/components/DiffView.tsx`, `apps/desktop/src/components/FilesPanel.tsx`, `apps/desktop/src/components/FileViewer.tsx`, `apps/desktop/src/lib/tab-actions.ts` |

Order matters: Task 1 lays the tab foundation that Tasks 3 and 4 both write into. Task 2 is independent but written after Task 1 since they share `FilesPanel.tsx`.
