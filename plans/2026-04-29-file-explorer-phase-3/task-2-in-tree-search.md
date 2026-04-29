# Task 2: In-tree search

**Plan:** File Explorer — Phase 3: Power-user Navigation
**Goal:** Add a search input at the top of the Files panel that filters the tree to matching paths and expands their ancestors. `Cmd+F` while the Files sidebar tab is active focuses the input.
**Depends on:** Task 1 (FilesPanel selection handler shape stabilises after Task 1)

**Files:**
- Modify: `apps/desktop/src/components/FilesPanel.tsx`
- Create: `apps/desktop/src/components/FileSearchInput.tsx`

**Background context:**
- `@pierre/trees`'s React entry exports `useFileTreeSearch(model: FileTree)` returning `{ isOpen, matchingPaths, value, close, focusNextMatch, focusPreviousMatch, open, setValue }`. Source: `node_modules/@pierre/trees/dist/react/useFileTreeSearch.d.ts`.
- The model itself accepts `fileTreeSearchMode: 'expand-matches' | 'collapse-non-matches' | 'hide-non-matches'` at construction (`node_modules/@pierre/trees/dist/model/types.d.ts`). `'expand-matches'` is the right mode: matching rows + their ancestors stay visible; non-matches are hidden.
- The model also has direct methods: `setSearch(value)`, `openSearch(initial?)`, `closeSearch()`. Use `setValue` from the React hook for the input → model bridge.
- Search performance is owned by the trees package — no debouncing required client-side.
- Existing project hotkey infrastructure: `useAppHotkey(name, handler)` from `apps/desktop/src/hooks/...` (search for it). The hotkey definitions are in some central config; this task adds a new entry.

**Steps:**

1. **Pass `fileTreeSearchMode: 'expand-matches'` to `useFileTree`** in `FilesPanel.tsx` (constructor options):

   ```tsx
   const { model } = useFileTree({
     paths: treePaths,
     initialExpansion: "closed",
     icons: { set: "standard", colored: true },
     gitStatus: gitStatusEntries,
     fileTreeSearchMode: "expand-matches",
     onSelectionChange: (selected) => handlerRef.current(selected),
   });
   ```

2. **Create `FileSearchInput.tsx`:**

   ```tsx
   import { useEffect, useRef } from "react";
   import { useFileTreeSearch } from "@pierre/trees/react";
   import type { FileTree } from "@pierre/trees";

   export function FileSearchInput({ model }: { model: FileTree }) {
     const search = useFileTreeSearch(model);
     const inputRef = useRef<HTMLInputElement>(null);

     // Close on Escape inside the input.
     const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
       if (e.key === "Escape") {
         search.close();
         inputRef.current?.blur();
       } else if (e.key === "ArrowDown") {
         e.preventDefault();
         search.focusNextMatch();
       } else if (e.key === "ArrowUp") {
         e.preventDefault();
         search.focusPreviousMatch();
       }
     };

     return (
       <div className="px-3 py-2 border-b border-border shrink-0">
         <input
           ref={inputRef}
           type="text"
           value={search.value}
           onChange={(e) => search.setValue(e.target.value)}
           onKeyDown={onKeyDown}
           placeholder="Search files…"
           className="w-full px-2 py-1 text-sm bg-input rounded outline-none focus:ring-1 focus:ring-ring"
           data-files-search-input
         />
         {search.value && search.matchingPaths.length === 0 && (
           <div className="mt-1 text-xs text-muted-foreground">No matches</div>
         )}
       </div>
     );
   }
   ```

   The `data-files-search-input` data-attribute is used by the Cmd+F hotkey in step 4 to find the input regardless of FilesPanel internals.

3. **Wire `FileSearchInput` above the tree in `FilesPanel`:**

   ```tsx
   return (
     <div className="h-full flex flex-col overflow-hidden">
       <FileSearchInput model={model} />
       <div className="flex-1 min-h-0 overflow-hidden">
         <FileTree model={model} style={{ height: "100%" }} />
       </div>
     </div>
   );
   ```

4. **Add a `Cmd+F` hotkey that focuses the input** when the Files sidebar tab is active. Steps:
   - Find the existing hotkey config (likely `apps/desktop/src/hooks/useAppHotkey.ts` or similar — grep for `useAppHotkey` definitions and one of the existing hotkey names like `SWITCH_TAB_DIFF`).
   - Add a new hotkey entry, e.g. `FOCUS_FILE_SEARCH`, bound to `Cmd+F` / `Ctrl+F`.
   - In `RightSidebar.tsx`, when the active sidebar tab is `"files"`, register the hotkey to focus the input:
     ```ts
     useAppHotkey("FOCUS_FILE_SEARCH", () => {
       if (activeTab !== "files") return;
       const el = document.querySelector("[data-files-search-input]");
       if (el instanceof HTMLInputElement) el.focus();
     });
     ```
   - **If `Cmd+F` is already taken by another action** (terminal find, etc.), defer the binding decision to the user. Search for existing `Cmd+F` / `meta+f` registrations before claiming it.

5. **Type-check + smoke.**

   ```bash
   cd apps/desktop && bun run typecheck
   ```

   Smoke: type "App" in the search → only files matching "App" remain visible with ancestors expanded. Cmd+F focuses the input. Esc clears focus and closes search. Arrow keys move match focus.

6. **Commit:**

   ```bash
   git add apps/desktop/src/components/FilesPanel.tsx apps/desktop/src/components/FileSearchInput.tsx
   # Plus whichever hotkey config file you touched
   git commit -m "feat(file-tree): in-tree search with Cmd+F focus"
   ```

**Done When:**
- [ ] `FileSearchInput` component exists and renders above the tree
- [ ] `useFileTree` constructed with `fileTreeSearchMode: 'expand-matches'`
- [ ] Search input updates `model.setSearch(value)` via the hook on every keystroke
- [ ] Esc closes search; Arrow keys move match focus
- [ ] `Cmd+F` focuses the input when Files sidebar tab is active (assuming the binding isn't already claimed)
- [ ] `bun run typecheck` passes
- [ ] Visual smoke confirms filter behaviour
- [ ] Changes committed
