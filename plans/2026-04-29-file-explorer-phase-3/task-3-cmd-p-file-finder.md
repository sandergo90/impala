# Task 3: Cmd+P file finder palette

**Plan:** File Explorer — Phase 3: Power-user Navigation
**Goal:** A separate Cmd+P palette (distinct from the existing Cmd+K command palette) that fuzzy-finds across the entire worktree's files. Selecting a file opens it as a preview tab; Cmd+Enter pins.
**Depends on:** Task 1 (uses `openFileTab`)

**Files:**
- Modify: `backend/tauri/src/file_tree.rs` — add `list_all_files` Tauri command
- Modify: `backend/tauri/src/lib.rs` — register the command
- Modify: `apps/desktop/package.json` — add `fzf-for-js`
- Create: `apps/desktop/src/hooks/useAllFiles.ts` — per-worktree cached list, invalidated on `fs-event` create/delete/rename
- Create: `apps/desktop/src/components/FileFinder.tsx` — cmdk palette
- Modify: hotkey config — add `OPEN_FILE_FINDER` bound to `Cmd+P`
- Modify: `apps/desktop/src/App.tsx` (or wherever the existing CommandPalette mounts) to also mount `FileFinder`

**Background context:**
- The existing CommandPalette uses `cmdk` (`apps/desktop/src/components/CommandPalette.tsx`). Reuse the cmdk imports + styling but build a separate component, separate hotkey, separate open state.
- `fzf-for-js` (npm package): exports a `Fzf` class with `find(query)`. Path-aware scoring built in. ~10KB minified+gzipped.
- The Rust `list_all_files` command: a full `ignore::WalkBuilder` walk (no `max_depth`). Use `standard_filters(false)` and `hidden(false)` to match the per-directory listing behaviour from Phase 2 (we want every file the user can browse). Skip `.git/`. Return `Vec<String>` of POSIX-relative paths.
- Cache invalidation: on every structured `fs-event-${sid}` of `kind: "create" | "delete" | "rename" | "overflow"`, the cached list is invalidated. The `update` events do not change the file list and can be ignored for this cache. Re-fetch lazily on next palette open.
- Empty state (no query): show recently-opened files. Source: current `userTabs` of `kind === "file"`, sorted by `createdAt` desc.

**Steps:**

1. **Add `list_all_files` to `backend/tauri/src/file_tree.rs`** (after `list_directory`):

   ```rust
   #[tauri::command]
   pub async fn list_all_files(
       worktree_path: String,
   ) -> Result<Vec<String>, String> {
       tokio::task::spawn_blocking(move || {
           let root = PathBuf::from(&worktree_path);
           let mut paths: Vec<String> = Vec::new();

           let walker = WalkBuilder::new(&root)
               .standard_filters(false)
               .hidden(false)
               .filter_entry(|e| {
                   // Skip the .git directory at any depth.
                   e.file_name().to_string_lossy() != ".git"
               })
               .build();

           for dent in walker.filter_map(Result::ok) {
               let path = dent.path();
               // Files only — directories aren't openable by the finder.
               match dent.file_type() {
                   Some(ft) if ft.is_file() || ft.is_symlink() => {}
                   _ => continue,
               }
               let relative = match path.strip_prefix(&root) {
                   Ok(r) => r,
                   Err(_) => continue,
               };
               paths.push(to_posix(relative));
           }
           paths.sort();
           Ok(paths)
       })
       .await
       .map_err(|e| format!("Task join error: {}", e))?
   }
   ```

   Register `file_tree::list_all_files` in `backend/tauri/src/lib.rs`'s `generate_handler!` block alongside `file_tree::list_directory`.

2. **Add `fzf-for-js`:**

   ```bash
   cd apps/desktop && bun add fzf-for-js
   ```

3. **Create `useAllFiles.ts`** — a hook that fetches and caches the file list per worktree:

   ```ts
   import { useEffect, useRef, useState, useCallback } from "react";
   import { invoke } from "@tauri-apps/api/core";
   import { listen, type UnlistenFn } from "@tauri-apps/api/event";
   import { sanitizeEventId } from "../lib/sanitize-event-id";

   interface FsEventPayload {
     kind: "create" | "update" | "delete" | "rename" | "overflow";
     path: string | null;
     oldPath: string | null;
     isDirectory: boolean | null;
   }

   /**
    * All file paths in the worktree, fetched lazily on first access and
    * invalidated when the watcher reports create / delete / rename / overflow.
    * `update` events don't change the listing so they're ignored.
    */
   export function useAllFiles(worktreePath: string | null) {
     const [paths, setPaths] = useState<string[] | null>(null);
     const fetchingRef = useRef(false);
     const epochRef = useRef(0);

     const fetchPaths = useCallback(async () => {
       if (!worktreePath || fetchingRef.current) return;
       fetchingRef.current = true;
       const myEpoch = epochRef.current;
       try {
         const result = await invoke<string[]>("list_all_files", {
           worktreePath,
         });
         if (myEpoch === epochRef.current) setPaths(result);
       } finally {
         fetchingRef.current = false;
       }
     }, [worktreePath]);

     // Reset on worktree change.
     useEffect(() => {
       epochRef.current += 1;
       setPaths(null);
       fetchingRef.current = false;
     }, [worktreePath]);

     // Invalidate on relevant fs events.
     useEffect(() => {
       if (!worktreePath) return;
       let unlisten: UnlistenFn | null = null;
       const eventName = `fs-event-${sanitizeEventId(worktreePath)}`;
       (async () => {
         unlisten = await listen<FsEventPayload>(eventName, (e) => {
           if (e.payload.kind === "update") return;
           epochRef.current += 1;
           setPaths(null);
         });
       })();
       return () => {
         if (unlisten) unlisten();
       };
     }, [worktreePath]);

     return { paths, fetchPaths };
   }
   ```

4. **Create `FileFinder.tsx`** — the cmdk palette, modelled on `CommandPalette.tsx` but file-only:

   ```tsx
   import { useEffect, useMemo, useState } from "react";
   import { Command } from "cmdk";
   import { Fzf } from "fzf-for-js";
   import { useUIStore } from "../store";
   import { useAllFiles } from "../hooks/useAllFiles";
   import { openFileTab } from "../lib/tab-actions";
   import { basename } from "../lib/path-utils";

   const MAX_RESULTS = 50;

   export function FileFinder({
     open,
     onOpenChange,
   }: {
     open: boolean;
     onOpenChange: (open: boolean) => void;
   }) {
     const selectedWorktree = useUIStore((s) => s.selectedWorktree);
     const wtPath = selectedWorktree?.path ?? null;
     const userTabs = useUIStore((s) =>
       wtPath ? s.worktreeNavStates[wtPath]?.userTabs ?? [] : [],
     );
     const { paths, fetchPaths } = useAllFiles(wtPath);
     const [query, setQuery] = useState("");

     // Fetch on first open after a worktree change / cache invalidation.
     useEffect(() => {
       if (open && wtPath && paths === null) {
         void fetchPaths();
       }
     }, [open, wtPath, paths, fetchPaths]);

     // Reset query on close.
     useEffect(() => {
       if (!open) setQuery("");
     }, [open]);

     const fzf = useMemo(() => {
       if (!paths) return null;
       return new Fzf(paths, { limit: MAX_RESULTS });
     }, [paths]);

     const recents = useMemo(() => {
       const fileTabs = userTabs.filter(
         (t): t is typeof t & { kind: "file"; path: string } =>
           t.kind === "file" && typeof t.path === "string",
       );
       fileTabs.sort((a, b) => b.createdAt - a.createdAt);
       return fileTabs.map((t) => t.path).slice(0, MAX_RESULTS);
     }, [userTabs]);

     const items = useMemo(() => {
       if (!query.trim()) return recents;
       if (!fzf) return [];
       return fzf.find(query).map((m) => m.item);
     }, [query, recents, fzf]);

     const onSelect = (path: string, pin: boolean) => {
       if (!wtPath) return;
       openFileTab(wtPath, path, pin);
       onOpenChange(false);
     };

     return (
       <Command.Dialog
         open={open}
         onOpenChange={onOpenChange}
         className="…" /* mirror CommandPalette.tsx styling */
         label="Go to file"
       >
         <Command.Input
           value={query}
           onValueChange={setQuery}
           placeholder={query ? "" : (paths === null ? "Loading files…" : "Type to search files")}
           onKeyDown={(e) => {
             if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
               // Pin the currently-highlighted item — cmdk exposes this via
               // the data-selected attribute on items. Read the focused
               // item's path off the dataset and call onSelect with pin=true.
               const sel = (e.currentTarget.closest("[cmdk-root]") as HTMLElement | null)
                 ?.querySelector('[cmdk-item][data-selected="true"]') as HTMLElement | null;
               const path = sel?.dataset.path;
               if (path) onSelect(path, true);
               e.preventDefault();
             }
           }}
         />
         <Command.List>
           {items.length === 0 && !query.trim() && (
             <Command.Empty>No recent files</Command.Empty>
           )}
           {items.length === 0 && query.trim() && (
             <Command.Empty>No matches</Command.Empty>
           )}
           {!query.trim() && items.length > 0 && (
             <Command.Group heading="Recent files">
               {items.map((path) => (
                 <FileItem key={path} path={path} onSelect={() => onSelect(path, false)} />
               ))}
             </Command.Group>
           )}
           {query.trim() && (
             <Command.Group heading="Files">
               {items.map((path) => (
                 <FileItem key={path} path={path} onSelect={() => onSelect(path, false)} />
               ))}
             </Command.Group>
           )}
         </Command.List>
       </Command.Dialog>
     );
   }

   function FileItem({ path, onSelect }: { path: string; onSelect: () => void }) {
     return (
       <Command.Item value={path} data-path={path} onSelect={onSelect}>
         <span className="font-medium">{basename(path)}</span>
         <span className="ml-2 text-xs text-muted-foreground">{path}</span>
       </Command.Item>
     );
   }
   ```

   **Verify the cmdk Dialog API by reading `node_modules/cmdk/dist/index.d.ts`.** If `Command.Dialog` doesn't exist or has a different prop shape, adapt to whatever the version exports. The existing `CommandPalette.tsx` may use a different shape (open via local state + portal); copy that shape if simpler.

5. **Mount the FileFinder.** Open `apps/desktop/src/App.tsx` (or wherever `<CommandPalette />` is mounted at top-level):

   ```tsx
   const [fileFinderOpen, setFileFinderOpen] = useState(false);
   useAppHotkey("OPEN_FILE_FINDER", () => setFileFinderOpen((v) => !v));
   …
   <FileFinder open={fileFinderOpen} onOpenChange={setFileFinderOpen} />
   ```

6. **Register the `OPEN_FILE_FINDER` hotkey.** Add to the hotkey config (the same file Task 2 modified) bound to `Cmd+P` / `Ctrl+P`.

   **Caveat:** if `Cmd+P` is already taken (e.g. tab switch — there's `SWITCH_TAB_*`), defer to the user. Run `grep -nrE "Cmd\+P|meta\+p|p" apps/desktop/src/hooks/` to check.

7. **Type-check + Cargo:**

   ```bash
   cd backend/tauri && cargo check
   cd apps/desktop && bun run typecheck
   ```

8. **Smoke test.** `bun run dev`. Press Cmd+P → palette opens. Type "App.tsx" → fuzzy-matched files appear. Enter → preview tab opens. Cmd+Enter → pinned tab opens. Press Cmd+P with empty query → recently-opened files (from current `userTabs`).

9. **Commit:**

   ```bash
   git add backend/tauri/src/file_tree.rs backend/tauri/src/lib.rs apps/desktop/package.json bun.lock apps/desktop/src/hooks/useAllFiles.ts apps/desktop/src/components/FileFinder.tsx apps/desktop/src/App.tsx
   # Plus whichever hotkey config file
   git commit -m "feat(file-tree): Cmd+P file finder palette with fzf ranking"
   ```

**Done When:**
- [ ] Rust `list_all_files` Tauri command registered
- [ ] `fzf-for-js` dep added
- [ ] `useAllFiles` hook fetches lazily, invalidates on relevant fs-events
- [ ] `FileFinder` renders a cmdk palette with empty-state recents and fuzzy-matched results
- [ ] Cmd+Enter pins the highlighted result
- [ ] `OPEN_FILE_FINDER` hotkey opens/closes the palette
- [ ] `cargo check` + `bun run typecheck` clean
- [ ] Smoke: Cmd+P → search → Enter opens preview tab; Cmd+Enter pins
- [ ] Changes committed
