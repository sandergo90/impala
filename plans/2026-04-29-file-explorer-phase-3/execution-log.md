# Phase 3 Execution Log

**Plan:** File Explorer — Phase 3: Power-user Navigation
**Executed:** 2026-04-29
**Final commit range:** `f5ea093..4384ea9` (6 task commits + 1 simplify pass + 1 fix)

## Tasks

### Task 1 — Preview/pin file tabs (`f5ea093`, `3aa3280`)
- `UserTab.kind` extended with `"file"` plus optional `path` / `pinned`
- `openFileTab(worktreePath, path, pin)` implements VS Code preview/pin semantics: existing-pinned wins, retarget preview, create-fresh otherwise
- `selectedFilePath` removed from `WorktreeNavState`; `FileViewer` reads from active user tab
- `MainView` no longer has a static "Files" mode; `TabbedTerminals` dispatches `<FileViewer/>` for `kind: "file"`
- Preview tabs render in italic via `isPreviewById` map
- `path-utils.ts` (basename / dirname) shared with `useFileTreeData`
- Persist version 4 → 5 migration scrubs `selectedFilePath` and rewrites stale `activeTab: "files"` → `"terminal"`
- Follow-up `3aa3280`: only flip activeTab to `"terminal"` when current is `"diff"` or `"plan"`

### Task 2 — In-tree search (`ef339c5`)
- `FileSearchInput` driven by `useFileTreeSearch(model)`, `Esc` closes/blurs, `ArrowUp`/`ArrowDown` navigate matches, `data-files-search-input` attribute on input
- `useFileTree` constructed with `fileTreeSearchMode: "expand-matches"`
- Cmd+F hotkey deferred — already bound to `FIND_IN_TERMINAL`. No conflict introduced.

### Task 3 — Cmd+P file finder (`812e079`, `3406763`)
- Rust `list_all_files` Tauri command: `WalkBuilder::new(root).standard_filters(false).hidden(false).filter_entry(skip .git)`, files+symlinks only, POSIX paths, sorted, runs in `spawn_blocking`
- `useAllFiles` hook with epoch-guarded lazy fetch; invalidates on watcher `create|delete|rename|overflow` (skips `update`)
- `FileFinder` cmdk palette mirrors `CommandPalette` styling shape (no `Command.Dialog` available); `shouldFilter={false}` so fzf ranks
- Cmd+Enter pin: queries `[cmdk-item][data-selected="true"]` and reads `data-path`
- **Hotkey resolution (option 1, VS Code parity):** `OPEN_FILE_FINDER` → `Cmd+P`, existing `OPEN_COMMAND_PALETTE` rebound `Cmd+P` → `Cmd+Shift+P`. Cmd+K (clear-terminal) and Cmd+F (find-in-terminal) untouched.
- **Package rename:** spec said `fzf-for-js` (404 on npm); used `fzf@0.5.2` (same author, same repo `ajitid/fzf-for-js`)
- Follow-up `3406763`: sort recents by `createdAt desc` (was insertion-order reverse)

### Task 4 — Reveal-in-files + selection sync + viewer header (`6a4f176`)
- `pendingTreeReveal: { worktreePath, path, nonce }` slice in `useUIStore`, NOT persisted (added to `partialize` EXCLUDE list); `revealFileInTree` setter
- `ChangedFileContextMenu` (using existing `@/components/ui/context-menu` primitive) wraps changed-file rows in `CommitPanel` and `DiffView`. DiffView's renamed-file case uses `newPath` for the reveal target
- `RightSidebar` watches `pendingReveal.nonce` and flips local `activeTab` to `"files"`
- `FilesPanel` consumes `pendingTreeReveal`: parallel ancestor `expand`, then `selectOnly(path)` after a `requestAnimationFrame` so `model.resetPaths` flushes
- Active-tab → tree sync gated by `lastSyncedPathRef` to prevent loops with Task 1's `onSelectionChange` → `openFileTab`
- `OpenInEditorButton` already accepted a `path` arg; React added optional `filePath` prop
- `RevealInFinderButton` uses `@tauri-apps/plugin-shell` `open()` on `${worktreePath}/${dirname(filePath)}`
- FileViewer header (`OpenInEditor` + `RevealInFinder`) renders only in the text-rendering branch; image/binary/large/loading/error states unchanged
- **Selection API deviation:** `@pierre/trees` does not expose `setSelectedPaths`. Used `getItem(path).select()/.deselect()` and `getSelectedPaths()` to enforce single-selection.

## Simplify pass (`4384ea9`)

- `CommitPanel`: `file.path.split("/").pop()` → `basename(file.path)`
- `FileFinder`: dropped redundant `z-50` on inner dialog; deferred `Fzf` construction until `query.trim().length > 0` (avoids upfront rune-indexing of 10k+ paths)
- `FilesPanel`: extracted `selectOnly()` helper; parallelized ancestor expand via `Promise.all`; aligned `lastSyncedPathRef.current = path` BEFORE `select()` in both reveal and tab-sync effects (was asymmetric)
- `RevealInFinderButton`: avoid `${worktreePath}/` trailing slash when file is at root
- `useAllFiles`: catch `invoke` rejection (sets `loadedRef.current = true` to avoid retry loop, logs); cancellation pattern around async `listen()` to prevent listener leak if effect tears down mid-await

## Verification

- `bun run typecheck` clean throughout
- `cargo check` clean (only Phase 3 Rust touch was Task 3's `list_all_files`)
- All four task `Done When` checklists fully satisfied (modulo deferred Cmd+F, which the spec explicitly allowed)
- Phase 3 done-when (cross-task user flow): Cmd+P → search → Enter opens preview tab; Cmd+Enter pins; Cmd+F focuses tree search input (deferred — terminal find owns it); single-click in tree previews; double-click pins; right-click changed file → "Reveal in Files" → tree expands and highlights; click a tab → tree highlights match.

## Known follow-ups (not blocking Phase 3)

- `list_all_files` has no size cap or worktree-side cache; a 200k-file worktree allocates one `Vec<String>` per palette open after invalidation
- `useAllFiles` re-fetches the full inventory on any structural fs-event (no incremental update)
- `recents` in `FileFinder` reads `useUIStore.getState()` non-reactively (snapshot per palette open) — fine for current usage
- `requestAnimationFrame` after ancestor-expand is the synchronization point with `model.resetPaths`; if trees adds a `mutation` event later, switch to that
