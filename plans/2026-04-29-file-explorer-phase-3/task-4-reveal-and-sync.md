# Task 4: Reveal-in-files context menu + selection sync + viewer header

**Plan:** File Explorer — Phase 3: Power-user Navigation
**Goal:** Right-clicking a changed file in the diff/commit panels offers "Reveal in Files" — switches the right sidebar to the Files tab, expands ancestors, selects the row. Two-way sync between active file tab and tree selection. The file viewer header gets `OpenInEditorButton` + a new `RevealInFinderButton`.
**Depends on:** Tasks 1 and 2

**Files:**
- Modify: `apps/desktop/src/components/CommitPanel.tsx` — add right-click context menu on changed-file rows
- Modify: `apps/desktop/src/components/DiffView.tsx` — same (per-file rows in the changed-files list)
- Modify: `apps/desktop/src/components/FilesPanel.tsx` — sync model selection from active tab; expose imperative `revealPath(path)` via a worktree-keyed ref/store helper
- Modify: `apps/desktop/src/components/FileViewer.tsx` — add `OpenInEditorButton` + new `RevealInFinderButton` header
- Modify: `apps/desktop/src/lib/tab-actions.ts` — extend `openFileTab` to also accept a "reveal" flag that triggers the tree-side reveal
- Create: `apps/desktop/src/components/RevealInFinderButton.tsx`

**Background context:**
- "Reveal in Files" is a *cross-component navigation*: the trigger lives in the diff view; the target lives in the right sidebar's Files tab. The cleanest decoupling is a small command in the UI store: `revealFileInTree(worktreePath, path)`. `RightSidebar` switches to its Files tab when it changes. `FilesPanel` watches it and runs the imperative reveal.
- "Reveal" mechanics on the trees side: walk ancestors (`expand("foo")`, `expand("foo/bar")`, ...), then call `model.setSelection?` or use `useFileTreeSelection` (`node_modules/@pierre/trees/dist/react/useFileTreeSelection.d.ts` — read it to confirm the API). Likely: `selection.set([targetPath])` or model-level `model.controller.setSelectedPaths([...])`.
- Existing `OpenInEditorButton` is in `apps/desktop/src/components/OpenInEditorButton.tsx` and accepts a `worktreePath`. It opens the worktree in the configured editor — to make it open a *specific file*, check whether it accepts a `filePath` prop already. If not, it'll need extending OR a wrapping helper. **Read the component before assuming.**
- "Reveal in Finder" is a Tauri shell call (`open` from `@tauri-apps/plugin-shell`) with the path's containing directory. Tauri 2 plugin-shell is already installed.
- Two-way sync direction A: tree → tab. Already wired in Task 1 (clicking a tree row creates/retargets the preview tab). No change needed.
- Two-way sync direction B: tab → tree. When the user clicks a tab in the tab bar, FilesPanel should highlight that file. Watch the active user tab, and if it's a `kind: "file"` tab, call `model.controller.setSelectedPaths([t.path])` (or whatever the API is). Don't trigger another `openFileTab` — that would loop.

**Steps:**

1. **Add `revealFileInTree` to `useUIStore`.** New transient (NOT persisted) field:

   ```ts
   // In UIState
   pendingTreeReveal: { worktreePath: string; path: string; nonce: number } | null;
   revealFileInTree: (worktreePath: string, path: string) => void;
   ```

   ```ts
   // setter
   revealFileInTree: (worktreePath, path) => set({
     pendingTreeReveal: { worktreePath, path, nonce: Date.now() },
   }),
   ```

   Add `pendingTreeReveal` to the partialize EXCLUDE list (it's transient — it'd be silly to persist a one-shot navigation intent across restarts).

   Also: when `revealFileInTree` fires, the right-sidebar Files tab should become active. `RightSidebar.tsx` already manages `activeTab` local state. Either:
   - lift `activeTab` to the store so this setter can also flip it, or
   - have `RightSidebar` watch `pendingTreeReveal` and set its own activeTab to `"files"` when it changes.

   The second option is more surgical. Implement it.

2. **Wire `FilesPanel` to consume `pendingTreeReveal`:**

   ```tsx
   const pendingReveal = useUIStore((s) => s.pendingTreeReveal);

   useEffect(() => {
     if (!wtPath || !pendingReveal || pendingReveal.worktreePath !== wtPath) return;
     const { path } = pendingReveal;
     // Expand ancestors, then select.
     const segments = path.split("/");
     (async () => {
       for (let i = 1; i < segments.length; i++) {
         const ancestor = segments.slice(0, i).join("/");
         await expand(ancestor); // no-op if already expanded
       }
       // Verify the actual selection API on the trees model — read
       // node_modules/@pierre/trees/dist/render/FileTree.d.ts.
       model.controller?.setSelectedPaths?.([path]); // or equivalent
     })();
   }, [pendingReveal?.nonce, wtPath, expand, model]);
   ```

3. **Add the right-click context menu in `CommitPanel.tsx`** on each changed-file row:
   - Use the existing project pattern for context menus. Search for `onContextMenu` usage in the codebase. If `@base-ui/react`'s context menu component is already used, follow that pattern; otherwise a `<div onContextMenu={...}>` with a small absolutely-positioned menu is acceptable.
   - The menu has at least: "Reveal in Files" (calls `revealFileInTree(wtPath, file.path)`).
   - Future-proof: the menu component should be extracted (e.g. `ChangedFileContextMenu.tsx`) so DiffView reuses it in step 4.

4. **Add the same context menu in `DiffView.tsx`** on the per-file rows (search for the file iteration in the diff view — Phase 1 docs noted this lives in `DiffView.tsx`).

5. **Two-way sync — tab → tree.** In `FilesPanel.tsx`, add an effect:

   ```tsx
   const activeTab = useUIStore((s) => {
     if (!wtPath) return null;
     const nav = s.worktreeNavStates[wtPath];
     if (!nav) return null;
     return nav.userTabs.find((t) => t.id === nav.activeTerminalsTab) ?? null;
   });

   useEffect(() => {
     if (!activeTab || activeTab.kind !== "file" || !activeTab.path) return;
     model.controller?.setSelectedPaths?.([activeTab.path]); // adapt to actual API
   }, [activeTab?.kind, activeTab?.path, model]);
   ```

   Beware infinite loops: the tree-side `onSelectionChange` (Task 1) calls `openFileTab`, which sets `activeTerminalsTab`. If THIS effect then calls `setSelectedPaths`, the trees package may fire another `onSelectionChange`. Verify the trees package's `setSelectedPaths` does NOT re-fire the listener for already-selected paths. If it does, gate with a ref:

   ```tsx
   const lastSyncedPathRef = useRef<string | null>(null);
   useEffect(() => {
     if (!activeTab || activeTab.kind !== "file" || !activeTab.path) return;
     if (lastSyncedPathRef.current === activeTab.path) return;
     lastSyncedPathRef.current = activeTab.path;
     model.controller?.setSelectedPaths?.([activeTab.path]);
   }, [activeTab?.kind, activeTab?.path, model]);
   ```

6. **`OpenInEditorButton` on FileViewer header.** Read the existing component first to see if it takes a `filePath` prop. If yes, just pass it. If no, extend the Rust `open_in_editor` command to accept a path. Concretely:
   - Today: opens `worktree_path` in editor.
   - Want: opens `${worktree_path}/${filePath}` if a path is given.
   - Update the Rust command + the React button to take an optional `filePath` prop.

7. **Create `RevealInFinderButton.tsx`:**

   ```tsx
   import { open } from "@tauri-apps/plugin-shell";
   import { dirname } from "../lib/path-utils";

   export function RevealInFinderButton({
     worktreePath,
     filePath,
   }: {
     worktreePath: string;
     filePath: string;
   }) {
     const onClick = async () => {
       const containingDir = `${worktreePath}/${dirname(filePath)}`;
       await open(containingDir);
     };
     return (
       <button onClick={onClick} title="Reveal in Finder" className="…">
         {/* lucide Folder icon */}
       </button>
     );
   }
   ```

   On macOS this opens the containing folder in Finder; on Linux/Windows the platform default. If you want to also highlight the file inside Finder (macOS-specific), shell out to `open -R <full-path>` via `plugin-shell`'s `Command`. Ship the simple version first.

8. **Wire the buttons into `FileViewer`'s header.** Add a small header bar above the rendering area:

   ```tsx
   {file && wtPath && selectedFilePath && (
     <div className="flex items-center justify-between px-3 py-1 border-b border-border text-xs">
       <span className="truncate">{selectedFilePath}</span>
       <div className="flex items-center gap-1">
         <OpenInEditorButton worktreePath={wtPath} filePath={selectedFilePath} />
         <RevealInFinderButton worktreePath={wtPath} filePath={selectedFilePath} />
       </div>
     </div>
   )}
   ```

   The header should only render in the text/source view path; not for image / binary / large-file / loading / error states (those have their own placeholders that include the path already — keep them clean).

9. **Type-check + smoke.**

   ```bash
   cd apps/desktop && bun run typecheck
   ```

   Smoke:
   - Right-click a changed file in the diff view → "Reveal in Files" → right sidebar switches to Files, ancestors expand, the row is selected.
   - Click a file tab in the tab bar → tree row updates to match.
   - Click a tree row → tab updates (preview behaviour from Task 1).
   - Open a text file → header shows path + open-in-editor + reveal-in-finder. Both work.

10. **Commit:**

    ```bash
    git add apps/desktop/src/store.ts apps/desktop/src/components/CommitPanel.tsx apps/desktop/src/components/DiffView.tsx apps/desktop/src/components/FilesPanel.tsx apps/desktop/src/components/FileViewer.tsx apps/desktop/src/components/RevealInFinderButton.tsx apps/desktop/src/components/RightSidebar.tsx apps/desktop/src/components/ChangedFileContextMenu.tsx apps/desktop/src/lib/tab-actions.ts apps/desktop/src/components/OpenInEditorButton.tsx
    # Backend if open_in_editor was extended:
    git add backend/tauri/src/lib.rs
    git commit -m "feat(file-tree): reveal-in-files, two-way selection sync, viewer header"
    ```

**Done When:**
- [ ] `pendingTreeReveal` slice + `revealFileInTree` setter exist in the UI store, NOT persisted
- [ ] Right-click on changed-file rows in `CommitPanel` and `DiffView` shows "Reveal in Files"
- [ ] Reveal switches the right sidebar to Files tab, expands ancestors, selects the row
- [ ] Active file tab → tree selection synced (no infinite loop)
- [ ] `OpenInEditorButton` opens the specific file (if it didn't already)
- [ ] `RevealInFinderButton` opens the containing folder
- [ ] `bun run typecheck` (and `cargo check` if backend touched) passes
- [ ] Smoke verified
- [ ] Changes committed

## Phase 3 Done When

- All four task files' `Done When` lists are checked off
- A user can: open Cmd+P → search → preview tab opens. Click another file → preview retargets. Double-click in tree → pins. Right-click a changed file in the diff → "Reveal in Files" → tree expands and highlights it. Type Cmd+F in the Files tab → search input focused. Click a tab → tree highlights match.
