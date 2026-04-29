# Task 2: Files tab in RightSidebar with `@pierre/trees`

**Plan:** File Explorer — Phase 1: Walking Skeleton
**Goal:** Add a `Files` tab to the right sidebar (positioned before `Changes`) that renders a lazy-loaded tree of the selected worktree, using `@pierre/trees/react`. Clicking a file row stores its path in the UI store; folders expand on click and fetch their children from Task 1's Rust command.
**Depends on:** Task 1

**Files:**

- Modify: `apps/desktop/package.json` — add `@pierre/trees` dep
- Create: `apps/desktop/src/hooks/useFileTreeData.ts`
- Create: `apps/desktop/src/components/FilesPanel.tsx`
- Modify: `apps/desktop/src/components/RightSidebar.tsx` (full file: 45 lines)
- Modify: `apps/desktop/src/types.ts:125-151` — add `selectedFilePath: string | null` to `WorktreeNavState`
- Modify: `apps/desktop/src/store.ts:9-25` — add `selectedFilePath: null` to `createDefaultNavState`

**Background context the implementer needs:**

- The `@pierre/trees` package ships a React entry at `@pierre/trees/react`. Public API used here:
  - `useFileTree({ paths: string[] })` — returns a model.
  - `<FileTree model={model} className={...} />` — the visual tree component.
  - Model methods we use: `model.add(paths)`, `model.resetPaths(paths)`, `model.getSelectedPaths()`, `model.getFocusedPath()`.
  - Selection / focus events arrive via callbacks on the component or via `useFileTreeSelector(model, selector)`.
  - **Read these before writing the hook**, as the precise event-callback API is package-version-specific. Run `cat node_modules/@pierre/trees/dist/react/index.d.ts | head -200` after install to confirm names.
- The tree is path-first: directories are inferred from "/" segments in the path list. Adding `apps/desktop/src/foo.ts` materialises `apps/`, `apps/desktop/`, `apps/desktop/src/` automatically.
- The watcher emits coarse `fs-changed-${sanitizedPath}` events. `sanitizedPath` replaces non-alphanumeric/non-`-_` chars with `-`. See `backend/tauri/src/watcher.rs:27-37`. We listen and refetch in Phase 1; path-level events come in Phase 2.
- Existing tab-pill pattern: see `RightSidebar.tsx` (current 45 lines) and `TabPill` component already imported there.
- File path conventions inside the tree: POSIX-style relative paths (no leading slash), matching the `relative_path` returned by `list_directory`. The tree treats segments separated by `/` as folders.

**Steps:**

1. **Install `@pierre/trees`:**

   ```bash
   cd apps/desktop && bun add @pierre/trees
   ```

   Then from the repo root, confirm:

   ```bash
   cat node_modules/@pierre/trees/package.json | head -20
   ```

   Expected: `"name": "@pierre/trees"`. Note the version. If `dist/react/index.d.ts` does not exist, stop and report — we need the React entry.

2. **Confirm the React API.** Read the type declarations:

   ```bash
   cat node_modules/@pierre/trees/dist/react/index.d.ts | head -200
   ```

   Look for: `useFileTree`, `FileTree` (the component), the prop name for the click/select callback, and whether the component accepts an `onSelect`/`onActivate`-style prop or whether selection is observed via a hook. Note these names — you'll use them in step 5 below. If the names differ from what's used in the example below, **adapt to the actual exports** rather than forcing the example.

3. **Add `selectedFilePath` to nav state.** In `apps/desktop/src/types.ts`, modify the `WorktreeNavState` interface (currently lines 125-151) by adding one field after `selectedFile`:

   ```ts
   /** Path (POSIX, worktree-relative) of the file currently shown in the Files viewer. Null when no file is open. */
   selectedFilePath: string | null;
   ```

   Then in `apps/desktop/src/store.ts`, add `selectedFilePath: null,` to the object returned by `createDefaultNavState` (currently lines 9-25), immediately after `selectedFile: null,`.

4. **Create the data hook.** Write `apps/desktop/src/hooks/useFileTreeData.ts`:

   ```ts
   import { useEffect, useMemo, useRef, useState, useCallback } from "react";
   import { invoke } from "@tauri-apps/api/core";
   import { listen, type UnlistenFn } from "@tauri-apps/api/event";

   export interface FsEntry {
     name: string;
     kind: "file" | "directory" | "symlink";
     relativePath: string;
     ignored: boolean;
   }

   function sanitizeEventId(id: string): string {
     return id.replace(/[^A-Za-z0-9_-]/g, "-");
   }

   /**
    * Lazy file-tree data fetcher.
    *
    * Owns:
    * - the union of all paths currently materialised in the tree
    * - the set of expanded directories (for refetch on watcher events)
    *
    * Phase 1 reacts to the existing coarse `fs-changed-*` event by refetching
    * root + every expanded directory and calling `setPaths` with the new union.
    * Phase 2 will switch to path-level events.
    */
   export function useFileTreeData(worktreePath: string | null) {
     const [paths, setPaths] = useState<string[]>([]);
     const [loading, setLoading] = useState(false);
     const expandedDirsRef = useRef<Set<string>>(new Set());
     const childrenByDirRef = useRef<Map<string, FsEntry[]>>(new Map());

     const fetchDir = useCallback(
       async (relDir: string): Promise<FsEntry[]> => {
         if (!worktreePath) return [];
         const entries = await invoke<FsEntry[]>("list_directory", {
           worktreePath,
           relDir,
         });
         childrenByDirRef.current.set(relDir, entries);
         return entries;
       },
       [worktreePath],
     );

     const recomputePaths = useCallback(() => {
       const all = new Set<string>();
       for (const entries of childrenByDirRef.current.values()) {
         for (const e of entries) all.add(e.relativePath);
       }
       setPaths(Array.from(all));
     }, []);

     const refetchAll = useCallback(async () => {
       if (!worktreePath) return;
       setLoading(true);
       try {
         await fetchDir("");
         for (const dir of expandedDirsRef.current) {
           await fetchDir(dir);
         }
         recomputePaths();
       } finally {
         setLoading(false);
       }
     }, [worktreePath, fetchDir, recomputePaths]);

     // Initial root fetch on worktree change.
     useEffect(() => {
       expandedDirsRef.current = new Set();
       childrenByDirRef.current = new Map();
       setPaths([]);
       if (!worktreePath) return;
       void refetchAll();
     }, [worktreePath, refetchAll]);

     // Watcher subscription: refetch on every fs change for now.
     useEffect(() => {
       if (!worktreePath) return;
       let unlisten: UnlistenFn | null = null;
       const eventName = `fs-changed-${sanitizeEventId(worktreePath)}`;
       (async () => {
         unlisten = await listen(eventName, () => {
           void refetchAll();
         });
       })();
       return () => {
         if (unlisten) unlisten();
       };
     }, [worktreePath, refetchAll]);

     const expand = useCallback(
       async (relDir: string) => {
         expandedDirsRef.current.add(relDir);
         await fetchDir(relDir);
         recomputePaths();
       },
       [fetchDir, recomputePaths],
     );

     const collapse = useCallback((relDir: string) => {
       expandedDirsRef.current.delete(relDir);
       // Keep children in the cache; simpler than rebuilding when re-expanded.
     }, []);

     // Map of path -> ignored, for renderer-side dimming.
     const ignoredMap = useMemo(() => {
       const m = new Map<string, boolean>();
       for (const entries of childrenByDirRef.current.values()) {
         for (const e of entries) m.set(e.relativePath, e.ignored);
       }
       return m;
     }, [paths]);

     return { paths, ignoredMap, loading, expand, collapse, refetchAll };
   }
   ```

5. **Create the panel component.** Write `apps/desktop/src/components/FilesPanel.tsx`:

   > **Note:** The exact `@pierre/trees/react` import names and event-callback prop name (e.g. `onSelectionChange` vs `onActivate` vs subscribing via `useFileTreeSelector`) are package-version-specific. The skeleton below uses placeholder names; **replace them with whatever step 2 above identified as the real exports.** If the package exposes folder-expand events, wire those to `expand(relDir)` / `collapse(relDir)`. If the package handles expansion fully internally and only requires paths, make the hook eagerly fetch loaded directories and skip the `expand`/`collapse` plumbing for Phase 1.

   ```tsx
   import { useEffect } from "react";
   import { useFileTree, FileTree } from "@pierre/trees/react";
   import { useUIStore } from "../store";
   import { useFileTreeData } from "../hooks/useFileTreeData";

   export function FilesPanel() {
     const selectedWorktree = useUIStore((s) => s.selectedWorktree);
     const wtPath = selectedWorktree?.path ?? null;
     const { paths, expand, collapse } = useFileTreeData(wtPath);

     const model = useFileTree({ paths });

     // Keep the tree's path list in sync as paths grow / refetches happen.
     useEffect(() => {
       model.resetPaths(paths);
     }, [model, paths]);

     if (!wtPath) {
       return (
         <div className="flex items-center justify-center h-full text-md text-muted-foreground">
           Select a worktree to browse files
         </div>
       );
     }

     // ⚠️ ADAPT to actual @pierre/trees React API surface. Confirmed at install
     // via `node_modules/@pierre/trees/dist/react/index.d.ts`. Wire:
     //  - folder expand → expand(path)
     //  - folder collapse → collapse(path)
     //  - file activation → set selectedFilePath in nav store
     return (
       <div className="h-full overflow-auto p-2">
         <FileTree
           model={model}
           onActivate={(path: string, isDir: boolean) => {
             if (isDir) {
               // tree handles open/close itself; we still need to fetch children
               // when first expanded. Use isOpen from model as gate (see step 2 docs).
               void expand(path);
               return;
             }
             useUIStore.getState().updateWorktreeNavState(wtPath, {
               selectedFilePath: path,
               activeTab: "files",
             });
           }}
           onCollapse={(path: string) => collapse(path)}
         />
       </div>
     );
   }
   ```

   This component will need to import the activeTab change — see Task 3 for the `"files"` activeTab value being added. It is OK to write `activeTab: "files"` here; Task 3 widens the type and the dev build won't break in the meantime because Task 3 lands before this is exercised end-to-end.

6. **Add the Files tab to RightSidebar.** Replace `apps/desktop/src/components/RightSidebar.tsx` with:

   ```tsx
   import { useState } from "react";
   import { CommitPanel } from "./CommitPanel";
   import { AnnotationsPanel } from "./AnnotationsPanel";
   import { PlanAnnotationsPanel } from "./PlanAnnotationsPanel";
   import { FilesPanel } from "./FilesPanel";
   import { TabPill } from "./TabPill";
   import { useUIStore } from "../store";

   type Tab = "files" | "changes" | "annotations";

   export function RightSidebar() {
     const [activeTab, setActiveTab] = useState<Tab>("files");

     const selectedWorktree = useUIStore((s) => s.selectedWorktree);
     const wtPath = selectedWorktree?.path ?? "";
     const navState = useUIStore((s) =>
       wtPath ? (s.worktreeNavStates[wtPath] ?? null) : null
     );
     const isInPlanView = navState?.activeTab === "plan";

     if (isInPlanView) {
       return (
         <div className="flex flex-col h-full overflow-hidden">
           <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
             <TabPill label="Plan Annotations" isActive onClick={() => {}} />
           </div>
           <div className="flex-1 min-h-0">
             <PlanAnnotationsPanel />
           </div>
         </div>
       );
     }

     return (
       <div className="flex flex-col h-full overflow-hidden">
         <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
           <TabPill label="Files" isActive={activeTab === "files"} onClick={() => setActiveTab("files")} />
           <TabPill label="Changes" isActive={activeTab === "changes"} onClick={() => setActiveTab("changes")} />
           <TabPill label="Annotations" isActive={activeTab === "annotations"} onClick={() => setActiveTab("annotations")} />
         </div>
         <div className="flex-1 min-h-0">
           {activeTab === "files" ? <FilesPanel /> : activeTab === "changes" ? <CommitPanel /> : <AnnotationsPanel />}
         </div>
       </div>
     );
   }
   ```

7. **Type-check.** From `apps/desktop/`:

   ```bash
   bun run typecheck
   ```

   Expected: clean. The `activeTab: "files"` write inside `FilesPanel` will reference a not-yet-widened union — Task 3 widens `WorktreeNavState["activeTab"]`. If you're running tasks strictly sequentially, you can either:
   - Comment out the `activeTab: "files"` line in `FilesPanel` and uncomment in Task 3, or
   - Land Task 3 first and Task 2 after (re-order — both are fine).

   If typecheck fails for any other reason, fix before continuing.

8. **Smoke test.** Run:

   ```bash
   bun run dev
   ```

   - Select a worktree.
   - The `Files` tab should appear in the right sidebar, active by default.
   - The tree should populate with the worktree's top-level entries.
   - Folders should be openable; opening a folder should reveal its immediate children. `node_modules` should be listed (this is a project that has it; Phase 2 will dim it via `ignoredMap`).
   - Clicking a *file* should set `selectedFilePath` in the store. Verify by opening devtools and running:
     ```js
     window.useUIStore?.getState?.().worktreeNavStates // inspect for selectedFilePath
     ```
     (Or inspect via Zustand devtools if installed.)
   - Switching to `Changes` then back to `Files` should preserve the tree expansion state.

9. **Commit:**

   ```bash
   git add apps/desktop/package.json apps/desktop/bun.lock apps/desktop/src/hooks/useFileTreeData.ts apps/desktop/src/components/FilesPanel.tsx apps/desktop/src/components/RightSidebar.tsx apps/desktop/src/types.ts apps/desktop/src/store.ts
   git commit -m "feat(file-tree): add Files tab with lazy worktree tree"
   ```

**Done When:**

- [ ] `@pierre/trees` installed
- [ ] `useFileTreeData.ts` and `FilesPanel.tsx` created
- [ ] `RightSidebar.tsx` shows `Files` tab before `Changes` and `Annotations`
- [ ] `WorktreeNavState.selectedFilePath` field added; default `null`
- [ ] `bun run typecheck` passes (modulo the documented Task 3 dependency)
- [ ] Dev app shows the tree, folders expand on click, file click writes `selectedFilePath`
- [ ] Watcher event triggers a refetch (touch a file: `touch /tmp-test-file && mv /tmp-test-file <worktree>/`, then check the tree updates)
- [ ] Changes committed
