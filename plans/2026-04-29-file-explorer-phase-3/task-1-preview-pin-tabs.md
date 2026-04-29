# Task 1: Preview/pin file tabs (replace MainView "files" mode)

**Plan:** File Explorer — Phase 3: Power-user Navigation
**Goal:** Move the file viewer from a single MainView mode into the dynamic tab bar (alongside agent/terminal user tabs). Single-click on a file in the tree opens the *preview* tab (italic, replaces the current preview); double-click pins it (no longer replaceable). Existing pinned tabs are never replaced.
**Depends on:** none

**Files:**
- Modify: `apps/desktop/src/types.ts` — extend `UserTab.kind`, add `path` and `pinned` fields, drop `"files"` from `WorktreeNavState["activeTab"]`
- Modify: `apps/desktop/src/lib/tab-actions.ts` — add `openFileTab(worktreePath, path, pinFlag)` that reuses-or-creates a preview tab and supports pinning
- Modify: `apps/desktop/src/components/FilesPanel.tsx` — selection handler delegates to `openFileTab(..., false)` for clicks; track double-click for pinning
- Modify: `apps/desktop/src/views/MainView.tsx` — remove the `activeTab === "files"` branch; render `<FileViewer />` instead of a terminal/agent pane when the active user tab is `kind: "file"`
- Modify: `apps/desktop/src/components/FileViewer.tsx` — read the active file's path from the active user tab rather than `worktreeNavStates[wt].selectedFilePath`. Drop `selectedFilePath` from `WorktreeNavState` (it's now redundant)
- Modify: `apps/desktop/src/components/RightSidebar.tsx` — the "Files" sidebar tab logic is unchanged; `isInPlanView` early-return path unchanged

**Background context:**
- `UserTab` shape today (`types.ts:103-110`):
  ```ts
  export interface UserTab {
    id: string;
    kind: "terminal" | "agent";
    label: string;
    createdAt: number;
    splitTree?: SplitNode;
    focusedPaneId?: string;
  }
  ```
  Extend `kind` and add `path` + `pinned`. Be careful: `splitTree`/`focusedPaneId` apply to PTY-hosting kinds; file tabs don't need them. Make `splitTree` and `focusedPaneId` optional (already optional today) and never set them for `kind: "file"`.
- `tab-actions.ts:57-98` (`createUserTab`): allocates the smallest unused integer slot per-kind ("Terminal 1", "Agent 2"). For file tabs we don't want numeric slot allocation — the label is the basename of the path. Skip `slot`/`parseLabelNumber` logic for `kind: "file"`.
- `pane-ids.ts:12-17`: `userTabPaneId(tabId)` and `paneSessionKey` produce PTY identifiers. **File tabs must not flow through these** — there's no PTY to spawn. Verify by grepping for `kind ===` callers in the codebase.
- VS Code preview semantics: there's at most ONE preview file tab per worktree at any time. Clicking another file in the tree while the preview tab exists *retargets it* (replaces the `path` in place; same tab id). Double-clicking promotes it (`pinned: true`); subsequent clicks then create a new preview tab.
- Active-tab tracking: `worktreeNavStates[wt].activeTerminalsTab` is the active user tab id (today only Terminal/Agent ids appear there). For file tabs it'll hold the file tab id.

**Steps:**

1. **Extend types.** In `apps/desktop/src/types.ts`:
   - Change `UserTab` to:
     ```ts
     export interface UserTab {
       id: string;
       kind: "terminal" | "agent" | "file";
       label: string;
       createdAt: number;
       /** Worktree-relative POSIX path; only set when kind === "file". */
       path?: string;
       /** Preview vs pinned semantics; only meaningful when kind === "file". */
       pinned?: boolean;
       splitTree?: SplitNode;
       focusedPaneId?: string;
     }
     ```
   - Change `WorktreeNavState["activeTab"]` (currently `"terminal" | "diff" | "split" | "plan" | "files"`) by removing `"files"`:
     ```ts
     activeTab: "terminal" | "diff" | "split" | "plan";
     ```
   - Drop `selectedFilePath: string | null` from `WorktreeNavState`. Search for callers — there are very few; FileViewer (Task 1 will rewrite it) and FilesPanel (this task rewrites the writer).

2. **Drop persistence + default.** In `apps/desktop/src/store.ts`:
   - Remove `selectedFilePath: null,` from `createDefaultNavState`.
   - The `worktreeExpandedDirs` field stays (it's tree-side, not file-side).

3. **Add tab actions.** In `apps/desktop/src/lib/tab-actions.ts`, add at the bottom (so existing exports stay stable):

   ```ts
   import { basename } from "../lib/path-utils"; // see step 4

   /**
    * Open a file in the dynamic tab bar with VS Code preview/pin semantics.
    *
    * - If a preview tab (kind: "file", pinned: false) exists, retarget its
    *   path; do not create a new tab.
    * - If `pin` is true, promote the (potentially just-created) preview tab
    *   to pinned, OR if a pinned tab for this exact path already exists,
    *   activate it instead of creating a duplicate.
    * - Otherwise create a fresh preview tab.
    */
   export function openFileTab(
     worktreePath: string,
     path: string,
     pin: boolean,
   ): UserTab {
     const uiState = useUIStore.getState();
     const nav = uiState.getWorktreeNavState(worktreePath);
     const label = basename(path);

     // Pinned tab for this path already exists — just activate it.
     const existingPinned = nav.userTabs.find(
       (t) => t.kind === "file" && t.pinned && t.path === path,
     );
     if (existingPinned) {
       uiState.updateWorktreeNavState(worktreePath, {
         activeTerminalsTab: existingPinned.id,
       });
       return existingPinned;
     }

     const previewTab = nav.userTabs.find(
       (t) => t.kind === "file" && !t.pinned,
     );

     if (previewTab) {
       const updated: UserTab = {
         ...previewTab,
         path,
         label,
         pinned: pin || previewTab.pinned,
       };
       const next = nav.userTabs.map((t) =>
         t.id === previewTab.id ? updated : t,
       );
       uiState.updateWorktreeNavState(worktreePath, {
         userTabs: next,
         activeTerminalsTab: updated.id,
       });
       return updated;
     }

     // No preview tab; create one.
     const tabId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
     const newTab: UserTab = {
       id: tabId,
       kind: "file",
       label,
       createdAt: Date.now(),
       path,
       pinned: pin,
     };
     uiState.updateWorktreeNavState(worktreePath, {
       userTabs: [...nav.userTabs, newTab],
       activeTerminalsTab: tabId,
     });
     return newTab;
   }
   ```

4. **Add `basename` helper.** Create `apps/desktop/src/lib/path-utils.ts`:

   ```ts
   /** Last segment of a POSIX path. Returns the input if no `/` is present. */
   export function basename(path: string): string {
     const slash = path.lastIndexOf("/");
     return slash === -1 ? path : path.slice(slash + 1);
   }

   /** Parent dir of a POSIX path; returns "" for root-level paths. */
   export function dirname(path: string): string {
     const slash = path.lastIndexOf("/");
     return slash === -1 ? "" : path.slice(0, slash);
   }
   ```

   Update `useFileTreeData.ts` to import `dirname` from this module instead of its local `parentDirOf` (which can be deleted in this task — surgical de-duplication).

5. **Update `closeUserTab`** in `tab-actions.ts:100-132` so that closing a file tab does NOT call `killPaneSession` (no PTY to kill). At the top of the function, after looking up the tab, branch on `tab.kind`:

   ```ts
   if (tab.kind !== "file") {
     const tree = getEffectiveUserTabSplitTree(tab);
     for (const leaf of getLeaves(tree)) killPaneSession(worktreePath, leaf.id);
   }
   ```

6. **Update `FilesPanel`** to call `openFileTab`. Replace the file-click branch in `handlerRef.current`:

   ```tsx
   handlerRef.current = (selected) => {
     if (!wtPath || selected.length === 0) return;
     const path = selected[selected.length - 1]!;
     if (path.endsWith("/")) {
       void expand(path.slice(0, -1));
       return;
     }
     openFileTab(wtPath, path, false); // preview
   };
   ```

   Add double-click pinning: trees package fires single-click via `onSelectionChange`; for double-click we need a row-level `onDoubleClick` listener, or we can use `onActivate` (different API, double-click). **Verify by reading `node_modules/@pierre/trees/dist/render/FileTree.d.ts` for the actual prop. If a double-click event is exposed, wire it to `openFileTab(wtPath, path, true)`. If not, defer pinning to Cmd+Enter on Cmd+P (Task 3) and a "Pin tab" context menu later.**

   Drop the `updateWorktreeNavState({ selectedFilePath, activeTab: "files" })` calls.

7. **Update `MainView`** to render `<FileViewer />` for `kind: "file"` user tabs:
   - Remove the `activeTab === "files"` branch entirely.
   - In the section where active user tab content renders (around the existing `<TabbedTerminals>` / `<XtermTerminal>` placement), add a kind check: if the active tab is a file tab, render `<FileViewer />` instead of the terminal/agent pane content. The active tab is found via `nav.userTabs.find(t => t.id === nav.activeTerminalsTab)`.
   - Remove the `Files` tab pill from the static tab list (around `MainView.tsx:268`).
   - Remove `setTab("files")` etc. — drop `"files"` from the `setTab` parameter union (back to `"terminal" | "diff" | "split" | "plan"`).
   - Remove the `import { FileViewer } from "../components/FileViewer";` if it was at the wrong scope; re-add it where the new render is placed.

8. **Update `FileViewer`** to read the active file's path from the active tab:

   ```tsx
   const activeTabId = useUIStore((s) =>
     wtPath ? s.worktreeNavStates[wtPath]?.activeTerminalsTab ?? null : null,
   );
   const activeTab = useUIStore((s) =>
     wtPath
       ? s.worktreeNavStates[wtPath]?.userTabs.find((t) => t.id === activeTabId) ?? null
       : null,
   );
   const selectedFilePath =
     activeTab && activeTab.kind === "file" ? activeTab.path ?? null : null;
   ```

   Everything else (stat, read, kind dispatch, rendering) stays the same.

9. **Visual: italic preview tabs.** In whatever component renders the user-tab pills (search the codebase — likely `TabbedTerminals.tsx` or `MainView.tsx`'s tab strip). For tabs where `tab.kind === "file" && !tab.pinned`, render the label in italic via `className="italic"`.

10. **Type-check + smoke tests.**

    ```bash
    cd apps/desktop && bun run typecheck
    ```

    Smoke test: click 3 different files in the tree → only ONE tab appears (the preview, retargeted each time). Click `node_modules/some-pkg/index.js` (it's an ignored entry but still selectable) → preview retargets there. Pin via Cmd+Enter from Cmd+P (Task 3) once that ships, OR via double-click if the trees package exposes it (verify in step 6).

11. **Commit:**

    ```bash
    git add apps/desktop/src/types.ts apps/desktop/src/store.ts apps/desktop/src/lib/tab-actions.ts apps/desktop/src/lib/path-utils.ts apps/desktop/src/hooks/useFileTreeData.ts apps/desktop/src/components/FilesPanel.tsx apps/desktop/src/components/FileViewer.tsx apps/desktop/src/views/MainView.tsx
    # Plus whichever tab-strip file got the italic styling
    git commit -m "feat(file-tree): preview/pin file tabs in dynamic tab bar"
    ```

**Done When:**
- [ ] `UserTab.kind` accepts `"file"` with `path` + `pinned` fields
- [ ] `openFileTab(worktreePath, path, pin)` implements VS Code preview/pin semantics (existing-pinned wins, retarget preview, create-if-none)
- [ ] `selectedFilePath` removed from `WorktreeNavState`; `FileViewer` reads from active user tab
- [ ] `MainView` renders `<FileViewer />` when the active user tab is a file tab; the `"files"` static-tab mode is removed
- [ ] Preview tabs render in italic
- [ ] Closing a file tab does NOT try to kill a PTY session
- [ ] `path-utils.ts` shared between `tab-actions.ts` and `useFileTreeData.ts`
- [ ] `bun run typecheck` passes
- [ ] Visual smoke confirms preview-replacement behaviour
- [ ] Changes committed
