# Task 3: File viewer mode in MainView

**Plan:** File Explorer — Phase 1: Walking Skeleton
**Goal:** Add a `"files"` mode to `MainView`'s static tab bar (next to `Terminal` / `Diff` / `Split` / `Plan`). When `selectedFilePath` is set, render `<File>` from `@pierre/diffs/react` showing the file's working-tree contents. Single slot — no preview/pin, no multi-tab.
**Depends on:** Task 2

**Files:**

- Modify: `apps/desktop/src/types.ts:125-126` — widen `WorktreeNavState["activeTab"]` to include `"files"`
- Create: `apps/desktop/src/components/FileViewer.tsx`
- Modify: `apps/desktop/src/views/MainView.tsx`:
  - line 82 — widen the `setTab` parameter type
  - around lines 263-268 — add `"files"` to the static tab list
  - around lines 350-396 — add a `activeTab === "files"` branch that renders `<FileViewer />`

**Background context the implementer needs:**

- The `<File>` component lives at `@pierre/diffs/react` (already a dep). Its props (from `node_modules/@pierre/diffs/dist/react/index.d.ts`): `FileProps` accepts a `file: File` (a model produced by `useFileInstance` or via the `templateRender` helpers) plus rendering options. **Confirm the precise prop names by reading the d.ts file before writing the component** — the example below uses what the design conversation established but versions drift.
- `MainView` already wraps its content in `WorkerPoolContextProvider` (around line 300) — this gives the `<File>` component its highlighter worker pool. We render the file viewer *inside* that wrapper, same as `<DiffView />`.
- File reads use `@tauri-apps/plugin-fs`'s `readTextFile`, exactly like `DiffView.tsx:164-167`.
- POSIX-relative paths from the tree: `apps/desktop/src/App.tsx`. The viewer needs the absolute path, which is `${worktreePath}/${selectedFilePath}`.
- Phase 1 doesn't handle binary / large / image files. If the user clicks a `.png`, the viewer will try to render bytes as text. That's acceptable — Phase 2 adds proper handling. Just don't crash.
- Tab switching is via `setTab(...)` (line 82 of MainView). Existing tabs are passed by value to `setTab` and persisted to `worktreeNavStates[wtPath].activeTab`. Adding `"files"` follows the same path.
- Hotkeys: `useAppHotkey("SWITCH_TAB_DIFF", () => setTab("diff"))` etc. We do NOT add a hotkey for the new files tab in Phase 1 — that lives with the broader hotkey-config work, not here.

**Steps:**

1. **Widen the activeTab union.** In `apps/desktop/src/types.ts`, change line 126 from:

   ```ts
     activeTab: "terminal" | "diff" | "split" | "plan";
   ```

   to:

   ```ts
     activeTab: "terminal" | "diff" | "split" | "plan" | "files";
   ```

2. **Create the viewer component.** Write `apps/desktop/src/components/FileViewer.tsx`:

   ```tsx
   import { useEffect, useState } from "react";
   import { readTextFile } from "@tauri-apps/plugin-fs";
   import { File, useFileInstance } from "@pierre/diffs/react";
   import { useUIStore } from "../store";

   export function FileViewer() {
     const selectedWorktree = useUIStore((s) => s.selectedWorktree);
     const wtPath = selectedWorktree?.path ?? null;
     const selectedFilePath = useUIStore((s) =>
       wtPath ? (s.worktreeNavStates[wtPath]?.selectedFilePath ?? null) : null
     );

     const [contents, setContents] = useState<string | null>(null);
     const [error, setError] = useState<string | null>(null);

     useEffect(() => {
       setContents(null);
       setError(null);
       if (!wtPath || !selectedFilePath) return;
       const fullPath = `${wtPath}/${selectedFilePath}`;
       let cancelled = false;
       (async () => {
         try {
           const text = await readTextFile(fullPath);
           if (!cancelled) setContents(text);
         } catch (e) {
           if (!cancelled) setError(String(e));
         }
       })();
       return () => {
         cancelled = true;
       };
     }, [wtPath, selectedFilePath]);

     if (!selectedFilePath) {
       return (
         <div className="flex items-center justify-center h-full text-md text-muted-foreground">
           Select a file in the Files tab to view its contents
         </div>
       );
     }

     if (error) {
       return (
         <div className="flex items-center justify-center h-full text-md text-destructive">
           Failed to read {selectedFilePath}: {error}
         </div>
       );
     }

     if (contents === null) {
       return (
         <div className="flex items-center justify-center h-full text-md text-muted-foreground">
           Loading {selectedFilePath}…
         </div>
       );
     }

     return (
       <PierreFileView
         path={selectedFilePath}
         contents={contents}
       />
     );
   }

   /**
    * Thin wrapper around @pierre/diffs `<File>`. Adapt to the actual exports.
    *
    * The d.ts to consult:
    *   node_modules/@pierre/diffs/dist/react/index.d.ts
    *
    * What we want: render `contents` as a single-pane source view, language
    * inferred from file extension. The package's `useFileInstance` builds a
    * model from contents + path; pass that to `<File>`.
    */
   function PierreFileView({ path, contents }: { path: string; contents: string }) {
     // ⚠️ ADAPT: the exact `useFileInstance` signature is package-version-specific.
     // Verify against the d.ts before relying on these arg names.
     const fileInstance = useFileInstance({
       path,
       contents,
     });
     return (
       <div className="h-full overflow-auto">
         <File file={fileInstance} />
       </div>
     );
   }
   ```

3. **Register the tab in MainView.** Open `apps/desktop/src/views/MainView.tsx`.

   a. **Widen `setTab`.** Around line 82, change:

   ```ts
     const setTab = (tab: "diff" | "terminal" | "split" | "plan") => {
   ```

   to:

   ```ts
     const setTab = (tab: "diff" | "terminal" | "split" | "plan" | "files") => {
   ```

   b. **Add the tab pill.** Around line 268, the tab list array — insert this entry as the LAST item (after `plan`):

   ```tsx
   { tab: "files" as const, label: "Files", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg> },
   ```

   (icon is the existing Plan icon with two extra horizontal lines for visual distinction.)

   c. **Add the rendering branch.** In the conditional rendering tree (around lines 350-396), find the `activeTab === "plan"` branch and add a new branch for `"files"` immediately after it (before `activeTab === "split"`):

   ```tsx
   ) : activeTab === "files" ? (
     <div className="flex-1 min-w-0">
       <FileViewer />
     </div>
   ) : activeTab === "split" ? (
   ```

   d. **Import FileViewer.** Add at the top of `MainView.tsx`, alongside the other component imports:

   ```ts
   import { FileViewer } from "../components/FileViewer";
   ```

4. **Wire the tree-click → tab-switch.** Already done in Task 2's `FilesPanel.tsx` via `updateWorktreeNavState(wtPath, { selectedFilePath: path, activeTab: "files" })`. Confirm that line is uncommented now that the union accepts `"files"`. If you commented it during Task 2 to keep the typecheck green, restore it.

5. **Type-check.**

   ```bash
   cd apps/desktop && bun run typecheck
   ```

   Expected: clean.

6. **Smoke test.** From the repo root:

   ```bash
   bun run dev
   ```

   - Select a worktree.
   - Click a text file in the Files tab (e.g. `apps/desktop/src/App.tsx`).
   - The center pane should switch to the new `Files` tab and render the file's contents with syntax highlighting (via `@pierre/diffs`'s built-in Shiki tokenizer).
   - Click another text file. The viewer should swap to the new file.
   - Click the `Diff` tab in the center bar. The diff view returns. Click `Files` again. The previously-opened file should still be there.
   - Edit the file from outside (e.g. `echo "// hello" >> apps/desktop/src/App.tsx`). The file viewer does *not* live-update in Phase 1 (deferred to Phase 2). Re-clicking the file in the tree should pick up the new contents.

7. **Sanity-check on edge inputs:**
   - Click a binary file (e.g. an icon `.png` if any exists in the worktree). The viewer attempts to render bytes as text — expected to look garbled in Phase 1 but **must not crash the app**. If it crashes, fix the FileViewer to catch the read error and render the error placeholder instead.
   - Click a file with no extension. Should render as plain text without a language assumption.

8. **Commit:**

   ```bash
   git add apps/desktop/src/types.ts apps/desktop/src/components/FileViewer.tsx apps/desktop/src/views/MainView.tsx
   git commit -m "feat(file-tree): add Files mode to MainView with single-file viewer"
   ```

**Done When:**

- [ ] `WorktreeNavState["activeTab"]` accepts `"files"`
- [ ] `FileViewer.tsx` exists and renders `<File>` for the selected path
- [ ] `MainView.tsx` has a `Files` tab pill and an `activeTab === "files"` rendering branch
- [ ] `bun run typecheck` passes
- [ ] Clicking a file in the tree switches to Files mode and shows highlighted contents
- [ ] Switching between Files and Diff tabs preserves the open file
- [ ] Binary/no-extension files do not crash the app
- [ ] Changes committed

## Phase 1 Done When

- All three task files' `Done When` lists are checked off
- A user can: select a worktree → click `Files` tab in right sidebar → expand folders → click a text file → see its contents in the center pane
