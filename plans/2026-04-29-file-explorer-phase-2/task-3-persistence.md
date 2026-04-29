# Task 3: Persistence (expanded folders + selectedFilePath)

**Plan:** File Explorer — Phase 2: Live + Decorated
**Goal:** Surviving an app restart, the user comes back to the worktree with the same folders expanded in the Files tab and the same file open in the viewer. Drop unknown paths on rehydrate (for files/folders that no longer exist).
**Depends on:** Task 1 (touches the same `useFileTreeData` hook surface)

**Files:**
- Modify: `apps/desktop/src/store.ts`
- Modify: `apps/desktop/src/hooks/useFileTreeData.ts`
- Modify: `apps/desktop/src/components/FilesPanel.tsx` (no behavioural change beyond hook signature update)

**Background context:**
- `useUIStore` already uses `zustand/middleware`'s `persist` (see `store.ts:1-2`). The `persist` config has a `partialize` allowlist controlling what's serialised. We extend that allowlist here.
- `worktreeNavStates[wt].selectedFilePath` already exists from Phase 1; it just needs to be in the persisted slice.
- `useFileTreeData` keeps `expandedDirsRef` as an in-memory `Set<string>` per hook instance, lost on remount. To persist across restarts, we promote it from a hook-local ref to a per-worktree slice in `useUIStore`, then hydrate the ref on worktree change.
- `expandedDirsRef` membership grows monotonically during a session (Phase 1 `collapse` was dropped from the API). We persist whatever's in it on each `expand` call.
- Drop-unknown-on-rehydrate: when the user reopens an Impala session, the worktree may have changed (files deleted, folders renamed). We validate the persisted paths against the freshly-fetched tree on first load; expanded paths whose parent fetches return no matching directory get pruned. **Phase 1's `useFileTreeData` already epoch-cancels stale fetches**, but here we're bringing in *more* state from outside; document the validation step.

**Steps:**

1. **Add `worktreeExpandedDirs` to `useUIStore`.** In `apps/desktop/src/store.ts`:

   a. Find the `UIState` interface (around line 47) and add:

   ```ts
   worktreeExpandedDirs: Record<string, string[]>;
   setWorktreeExpandedDirs: (worktreePath: string, dirs: string[]) => void;
   ```

   b. Initial value alongside the other defaults:

   ```ts
   worktreeExpandedDirs: {},
   ```

   c. Setter implementation:

   ```ts
   setWorktreeExpandedDirs: (worktreePath, dirs) => set((state) => ({
     worktreeExpandedDirs: {
       ...state.worktreeExpandedDirs,
       [worktreePath]: dirs,
     },
   })),
   ```

   d. Find the `persist` config's `partialize` (it should be near the bottom of the `useUIStore` definition; search for `partialize`). Add `worktreeExpandedDirs` to the persisted keys. Also confirm `worktreeNavStates` is already persisted — `selectedFilePath` rides on it via `WorktreeNavState`. If `worktreeNavStates` is NOT in the partialize list, **stop and ask** — extending what's persisted in nav state is a non-trivial decision (we'd be persisting `selectedCommit`, `viewMode`, etc. as side effects, which may not be desired).

2. **Hydrate `expandedDirsRef` from the store; sync writes.** In `apps/desktop/src/hooks/useFileTreeData.ts`:

   a. Import the store getter for the persisted slice.

   b. On worktree change (the existing reset effect), populate `expandedDirsRef.current` from the persisted slice:

   ```ts
   useEffect(() => {
     epochRef.current += 1;
     const persisted = useUIStore.getState().worktreeExpandedDirs[worktreePath ?? ""] ?? [];
     expandedDirsRef.current = new Set(persisted);
     childrenByDirRef.current = new Map();
     prevPathsKeyRef.current = "";
     setPaths([]);
     setEntriesByPath(new Map()); // (post-Task-1 shape)
     if (!worktreePath) return;
     void refetchAll();
   }, [worktreePath, refetchAll]);
   ```

   `refetchAll` already loops over `expandedDirsRef.current`, so the previously-expanded directories will be fetched on first load.

   c. In `expand`, after a successful fetch + recompute, write back to the store:

   ```ts
   const expand = useCallback(
     async (relDir: string) => {
       if (expandedDirsRef.current.has(relDir)) return;
       const myEpoch = epochRef.current;
       expandedDirsRef.current.add(relDir);
       await fetchDir(relDir);
       if (myEpoch !== epochRef.current) return;
       recomputePaths();
       if (worktreePath) {
         useUIStore
           .getState()
           .setWorktreeExpandedDirs(worktreePath, Array.from(expandedDirsRef.current));
       }
     },
     [fetchDir, recomputePaths, worktreePath],
   );
   ```

   d. Drop-unknown-on-rehydrate: after the initial `refetchAll` resolves, walk `expandedDirsRef.current` and remove any entry whose parent's children no longer include it as a directory. Add this at the end of `refetchAll`:

   ```ts
   const refetchAll = useCallback(async () => {
     if (!worktreePath) return;
     const myEpoch = epochRef.current;
     await Promise.all([
       fetchDir(""),
       ...Array.from(expandedDirsRef.current).map((d) => fetchDir(d)),
     ]);
     if (myEpoch !== epochRef.current) return;

     // Drop expanded paths that no longer correspond to a directory entry.
     const validDirs = new Set<string>();
     for (const entries of childrenByDirRef.current.values()) {
       for (const e of entries) {
         if (e.kind === "directory") validDirs.add(e.relativePath);
       }
     }
     // Also keep "" (root is always valid) and any path that resolved to a
     // populated children entry (it's a real dir even if its parent wasn't fetched).
     for (const dir of childrenByDirRef.current.keys()) {
       if (dir !== "") validDirs.add(dir);
     }
     const pruned = new Set<string>();
     for (const dir of expandedDirsRef.current) {
       if (validDirs.has(dir)) pruned.add(dir);
     }
     if (pruned.size !== expandedDirsRef.current.size) {
       expandedDirsRef.current = pruned;
       useUIStore
         .getState()
         .setWorktreeExpandedDirs(worktreePath, Array.from(pruned));
     }

     recomputePaths();
   }, [worktreePath, fetchDir, recomputePaths]);
   ```

3. **Ensure `WorktreeNavState.selectedFilePath` is on the persistence allowlist.** This depends on whether `worktreeNavStates` is already partialized. If it is, you're done — `selectedFilePath` rides along. If not, the right thing is probably to add it. **If extending what gets persisted from `worktreeNavStates`, the implementer must surface this to the user before doing it** — it changes the semantics of every nav-state field (e.g. `selectedCommit` would survive restart too). One option: add a *separate* `worktreeSelectedFilePath: Record<string, string | null>` slice to keep the persistence narrow, then update `FilesPanel`'s click handler to write to *both* `worktreeNavStates[wt].selectedFilePath` (in-memory) and the persisted slice. Slightly more code but cleaner semantically.

   The implementer should pick one approach; both are reasonable. Lean toward minimal scope: if `worktreeNavStates` is not currently persisted, prefer the separate slice over expanding what survives restart for the whole nav state.

4. **Type-check.**

   ```bash
   cd apps/desktop && bun run typecheck
   ```

5. **Smoke test.**

   - Open a worktree.
   - Expand 3 nested folders, click a file (which renders in the viewer).
   - Quit the app (`Cmd+Q`).
   - Reopen.
   - Same worktree should still be selected (existing behaviour from `selectedWorktree` persistence).
   - The 3 folders should still be expanded.
   - The same file should still be open in the viewer.
   - Then: from the terminal, delete one of the expanded folders (`rm -rf path/to/expanded/dir`) while the app is still open. The watcher should refetch; the deleted folder should disappear from the tree; on next restart it should also not be re-expanded (the rehydrate prune fires).

6. **Commit:**

   ```bash
   git add apps/desktop/src/store.ts apps/desktop/src/hooks/useFileTreeData.ts apps/desktop/src/components/FilesPanel.tsx
   git commit -m "feat(file-tree): persist expanded folders and selected file across restarts"
   ```

**Done When:**

- [ ] `useUIStore` has `worktreeExpandedDirs` + `setWorktreeExpandedDirs`, both persisted via the existing partialize
- [ ] `useFileTreeData` hydrates the expanded set from persisted state on worktree change and writes back on each expand
- [ ] Stale paths from a previous session are pruned after the first refetch
- [ ] `selectedFilePath` survives restart (decision logged: rode on `worktreeNavStates` OR a new dedicated slice)
- [ ] `bun run typecheck` passes
- [ ] Smoke verified: expand-quit-reopen restores the tree state and viewer
- [ ] Changes committed
