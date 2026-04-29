# Task 1: Git status + ignored decoration + built-in icons

**Plan:** File Explorer — Phase 2: Live + Decorated
**Goal:** Decorate tree rows with git status (modified/added/deleted/renamed/untracked) AND ignored-row dimming, both via the trees package's `setGitStatus()` API. Enable the built-in `'standard'` icon set with `colored: true`. Drop the now-redundant `ignoredMap` return from `useFileTreeData`.
**Depends on:** none

**Files:**
- Create: `apps/desktop/src/lib/git-status.ts`
- Modify: `apps/desktop/src/hooks/useFileTreeData.ts`
- Modify: `apps/desktop/src/components/FilesPanel.tsx`

**Background context:**
- The trees model exposes `setGitStatus(entries: readonly GitStatusEntry[])`. `GitStatusEntry = { path: string; status: GitStatus }`. `GitStatus = 'added' | 'deleted' | 'ignored' | 'modified' | 'renamed' | 'untracked'`. (Source: `node_modules/@pierre/trees/dist/types.d.ts`.)
- The trees model exposes `setIcons(icons?: FileTreeIcons)`. `FileTreeIcons = 'minimal' | 'standard' | 'complete' | FileTreeIconConfig`. `FileTreeIconConfig` accepts `{ set, colored, byFileName, byFileExtension, byFileNameContains, ... }`. (Source: `node_modules/@pierre/trees/dist/iconConfig.d.ts`.) Use the built-in set, no Iconify needed.
- Tree path convention from Phase 1: directory paths end with `/`, file paths do not. `setGitStatus` paths must match — so feed paths in their tree-shape (i.e. directory entries with the trailing `/` for ignored-folder dimming, file entries without). The `dirSet` returned by `useFileTreeData` tells you which is which.
- `ChangedFile.status` from the existing `worktreeDataStates[wt].changedFiles` store slice is a raw git porcelain status code: typically `"M"`, `"A"`, `"D"`, `"R"` (rename), `"??"` (untracked). It's `string` in TS (`apps/desktop/src/types.ts:23`). The Rust side comes from `git status --porcelain` (XY two-char) or `git diff-tree --name-status` (single char with optional similarity number for renames). Map to the trees `GitStatus` enum.
- The `ignoredMap` returned today by `useFileTreeData` is currently unused by `FilesPanel`. Task 1 consumes it (for the `'ignored'` GitStatus entries) and drops it from the returned API to keep the hook surface lean.

**Steps:**

1. **Create the git-status mapping helper.** Write `apps/desktop/src/lib/git-status.ts`:

   ```ts
   import type { GitStatus } from "@pierre/trees";

   /**
    * Map a raw git porcelain status code (XY two-char from `git status --porcelain`
    * or single-char from `diff-tree --name-status`) to the trees-package GitStatus.
    *
    * Returns null when the code is unrecognised — callers should drop the entry
    * rather than guess.
    */
   export function mapGitStatus(raw: string): GitStatus | null {
     if (!raw) return null;
     const code = raw.trim();
     // Two-char porcelain (XY): take whichever side has actual signal.
     // Untracked/ignored come through as "??" / "!!".
     if (code === "??") return "untracked";
     if (code === "!!") return "ignored";
     // Single-char or first-char of XY.
     const c = code[0]!;
     if (c === "M" || c === "T") return "modified";
     if (c === "A") return "added";
     if (c === "D") return "deleted";
     if (c === "R" || c === "C") return "renamed";
     if (c === "U") return "modified"; // unmerged → surface as modified
     // Two-char with a space prefix means worktree-only change; second char dominates.
     if (c === " " && code.length > 1) {
       return mapGitStatus(code.slice(1));
     }
     return null;
   }
   ```

2. **Drop `ignoredMap` from the hook's return AND have the hook publish a richer per-entry data structure.** In `apps/desktop/src/hooks/useFileTreeData.ts`:

   a. Add a new state: `entriesByPath: Map<string, FsEntry>`. This replaces both `dirSet` (derivable: `entriesByPath.get(p)?.kind === "directory"`) and `ignoredMap` (derivable: `entriesByPath.get(p)?.ignored`).

   b. Update `recomputePaths` to populate `entriesByPath` in the same single pass alongside `paths`. Keep the cache-key short-circuit.

   c. Drop the `dirSet` and `ignoredMap` state entirely. Drop them from the return.

   d. Return `{ paths, entriesByPath, expand }` only. Consumers compute dir-status and ignored-status from `entriesByPath`.

   Concrete shape after edit:

   ```ts
   const [paths, setPaths] = useState<string[]>([]);
   const [entriesByPath, setEntriesByPath] = useState<Map<string, FsEntry>>(new Map());

   // (in recomputePaths, single pass)
   const all: string[] = [];
   const byPath = new Map<string, FsEntry>();
   for (const entries of childrenByDirRef.current.values()) {
     for (const e of entries) {
       all.push(e.relativePath);
       byPath.set(e.relativePath, e);
     }
   }
   all.sort();
   const key = all.join("\0");
   if (key === prevPathsKeyRef.current) return;
   prevPathsKeyRef.current = key;
   setPaths(all);
   setEntriesByPath(byPath);
   ```

   And the worktree-reset effect resets `setEntriesByPath(new Map())`.

3. **Build a `gitStatusEntries` derivation in `FilesPanel`.** This combines `changedFiles` from the data store (via Zustand selector) and ignored entries from the hook. In `FilesPanel.tsx`:

   ```tsx
   import { useDataStore } from "../store";
   import { mapGitStatus } from "../lib/git-status";
   // ... existing imports ...

   export function FilesPanel() {
     const selectedWorktree = useUIStore((s) => s.selectedWorktree);
     const wtPath = selectedWorktree?.path ?? null;
     const { paths, entriesByPath, expand } = useFileTreeData(wtPath);

     const changedFiles = useDataStore((s) =>
       wtPath ? (s.worktreeDataStates[wtPath]?.changedFiles ?? []) : []
     );

     // Tree paths: directories suffixed with `/`.
     const treePaths = useMemo(
       () => paths.map((p) => (entriesByPath.get(p)?.kind === "directory" ? `${p}/` : p)),
       [paths, entriesByPath],
     );

     // Combined git-status feed: changed files (mapped from porcelain codes) +
     // ignored entries from the filesystem walk. Trees handles folder-rolls-up
     // internally given the per-file entries.
     const gitStatusEntries = useMemo(() => {
       const out: { path: string; status: GitStatus }[] = [];
       for (const cf of changedFiles) {
         const status = mapGitStatus(cf.status);
         if (status) out.push({ path: cf.path, status });
       }
       for (const [p, entry] of entriesByPath) {
         if (entry.ignored) {
           const treePath = entry.kind === "directory" ? `${p}/` : p;
           out.push({ path: treePath, status: "ignored" });
         }
       }
       return out;
     }, [changedFiles, entriesByPath]);

     // ... handlerRef setup unchanged ...

     const { model } = useFileTree({
       paths: treePaths,
       initialExpansion: "closed",
       icons: { set: "standard", colored: true },
       gitStatus: gitStatusEntries,
       onSelectionChange: (selected) => handlerRef.current(selected),
     });

     useEffect(() => {
       model.resetPaths(treePaths);
     }, [model, treePaths]);

     useEffect(() => {
       model.setGitStatus(gitStatusEntries);
     }, [model, gitStatusEntries]);

     // ... rest unchanged
   }
   ```

   Important: import the `GitStatus` type from `@pierre/trees` (the root export, not `/react`). Verify the actual export name in `node_modules/@pierre/trees/dist/index.d.ts` if the import errors.

4. **Type-check.** From `apps/desktop/`:

   ```bash
   bun run typecheck
   ```

   Must be clean.

5. **Smoke test.** From the repo root:

   ```bash
   bun run dev
   ```

   - Select a worktree with uncommitted changes.
   - Files in `changedFiles` should render with their git-status colour (modified = orange-ish, added = green, deleted = red, etc., depending on the trees package's defaults).
   - `node_modules/`, `target/`, etc. should appear dimmed (ignored) — both the folder row and any expanded children.
   - File-type icons should appear: `.ts` files distinct from `.json` from `.md`, etc. Folders distinct from files.
   - Sanity-check: a file you've edited but not staged shows as modified; a brand-new untracked file shows as untracked; deletions show as deleted.

6. **Commit:**

   ```bash
   git add apps/desktop/src/lib/git-status.ts apps/desktop/src/hooks/useFileTreeData.ts apps/desktop/src/components/FilesPanel.tsx
   git commit -m "feat(file-tree): git status decoration + built-in icons"
   ```

**Done When:**

- [ ] `lib/git-status.ts` exists with `mapGitStatus`
- [ ] `useFileTreeData` returns `{ paths, entriesByPath, expand }` (no separate `dirSet`/`ignoredMap`)
- [ ] `FilesPanel` derives `gitStatusEntries` from `changedFiles` + ignored entries and feeds via `setGitStatus`
- [ ] Tree renders with the built-in `'standard'` colored icon set
- [ ] `bun run typecheck` passes
- [ ] Visual smoke: changed files coloured, ignored entries dimmed, icons present
- [ ] Changes committed
