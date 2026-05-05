# Execution Log: File Open — Modifier-Key Routing

**Plan:** `plans/file-open-modifier-keys.md`
**ADR:** `docs/adr/0001-file-open-modifier-key-scheme.md`
**Completed:** 2026-05-05

## Tasks

| # | Name | Classification | Status | Reviewer | Fixes | Commit |
|---|------|----------------|--------|----------|-------|--------|
| 1 | Line-jump plumbing + `openFileTab` options | moderate | DONE | Approved (1 round) | none | `970becc` |
| 2 | Wire modifier-key scheme across click sites | moderate | DONE | Approved (2 rounds) | cmdk overrides user `onClick` on `Command.Item` — switched to `onMouseDown` | `6616e99` + `7d4243d` |

## Files Changed

Task 1 (`970becc`):
- `apps/desktop/src/stores/editor-docs.ts` — added `pendingTargets` slot, setters, removeDoc cleanup
- `apps/desktop/src/lib/tab-actions.ts` — `openFileTab(worktreePath, path, opts)` with `parkPendingTarget()` covering all three return branches
- `apps/desktop/src/components/CodeEditor/CodeEditor.tsx` — `CodeEditorHandle.goto(line, col?)` with clamp + scrollIntoView + focus
- `apps/desktop/src/components/FileViewer.tsx` — editorRef + pendingTarget effect (rAF-deferred goto + clear)
- `apps/desktop/src/components/FilesPanel.tsx`, `FileFinder.tsx` — call-shape migration to options object

Task 2 (`6616e99` + fix `7d4243d`):
- `apps/desktop/src/components/AnnotationDisplay.tsx` — bare-click → `openFileTab` with line; Cmd+click → `openFileInEditor`
- `apps/desktop/src/components/DiffView.tsx` — `OpenFileButton` onClick takes `MouseEvent`; both call-sites route by modifier
- `apps/desktop/src/components/FilesPanel.tsx` — capture-phase `handleClickCapture` short-circuits on Cmd+click; preserves double-click pin
- `apps/desktop/src/components/FileFinder.tsx` — `FileItem` uses `onMouseDown` (cmdk-safe) for Cmd+click; footer adds `⌘click IDE`
- `apps/desktop/src/lib/terminal-link-provider.ts` — `activate` checks modifier; computes relative path via `baseDir` prefix; falls back to external when outside worktree

## Issues Encountered

- **cmdk overrides `onClick` on `Command.Item`** (caught in Task 2 review). cmdk@1.1.1's `Item` renders the underlying div with its own `onClick` after the user props spread, so any user-supplied `onClick` is silently dropped. Switched to `onMouseDown` + `preventDefault`/`stopPropagation`, which fires before cmdk's click handler and isn't overridden.
- **`CommitPanel.tsx:351`** has a Cmd+click handler on changed-file rows; left unchanged because bare click on those rows is a navigation action (selects the file in the diff view), not a file-open trigger.

## Test Results

- `bun run typecheck` — **passes** (FULL TURBO cache).
- Manual GUI smoke-tests deferred to user (the implementers had no GUI environment). The plan lists ten manual scenarios under Task 2 step 7; recommend running them before merging.

## Notes for the user

- `OpenInEditorButton` (split button in FileViewer header + MainView toolbar) is unchanged. It remains the explicit "open in IDE" affordance with its own dropdown.
- `preferredEditor` default and migration are unchanged. Existing users keep their preference.
- The line-jump plumbing also benefits any future call site that wants to open a file at a specific line — `openFileTab(wt, path, { line, col })` is now the single entry point.
