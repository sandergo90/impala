# Split Zustand Store: UI Store + Data Store

## Summary

Split the monolithic Zustand store into two stores for performance and persistence. `uiStore` holds small, persisted navigation state. `dataStore` holds large, transient data that's re-fetched on startup.

## Design Decisions

- **Two stores, not many** — one persistent (navigation/preferences), one transient (data). Clear mental model.
- **Full persistence for uiStore** — no `partialize` needed, everything is small and worth persisting.
- **No persistence for dataStore** — all data is re-fetched from Tauri/git on startup.
- **Startup restoration** — app hydrates uiStore from localStorage, then re-fetches data for the persisted project/worktree.

## Store Definitions

### `uiStore` (persisted as `differ-ui-state` in localStorage)

```typescript
interface WorktreeNavState {
  activeTab: 'terminal' | 'diff';
  showSplit: boolean;
  viewMode: 'commit' | 'all-changes' | 'uncommitted';
  selectedCommit: CommitInfo | null;
  selectedFile: ChangedFile | null;
}

interface UIState {
  // Global selections
  selectedProject: Project | null;
  setSelectedProject: (project: Project | null) => void;
  selectedWorktree: Worktree | null;
  setSelectedWorktree: (worktree: Worktree | null) => void;

  // Diff view preferences
  diffStyle: 'split' | 'unified';
  setDiffStyle: (style: 'split' | 'unified') => void;
  wrap: boolean;
  setWrap: (wrap: boolean) => void;

  // Per-worktree navigation
  worktreeNavStates: Record<string, WorktreeNavState>;
  getWorktreeNavState: (path: string) => WorktreeNavState;
  updateWorktreeNavState: (path: string, updates: Partial<WorktreeNavState>) => void;
}
```

**Default nav state:**
```typescript
const defaultWorktreeNavState: WorktreeNavState = {
  activeTab: 'diff',
  showSplit: false,
  viewMode: 'commit',
  selectedCommit: null,
  selectedFile: null,
};
```

**Persistence:** Entire store persisted. `partialize` excludes only the setter functions (Zustand handles this automatically with `persist`). Store name: `differ-ui-state` (same key as current, will migrate naturally since it's a superset).

### `dataStore` (not persisted)

```typescript
interface WorktreeDataState {
  ptySessionId: string | null;
  commits: CommitInfo[];
  changedFiles: ChangedFile[];
  baseBranch: string | null;
  diffText: string | null;
  fileDiffs: Record<string, string>;
  annotations: Annotation[];
}

interface DataState {
  // Projects
  projects: Project[];
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (path: string) => void;

  // Worktrees
  worktrees: Worktree[];
  setWorktrees: (worktrees: Worktree[]) => void;

  // Per-worktree data
  worktreeDataStates: Record<string, WorktreeDataState>;
  getWorktreeDataState: (path: string) => WorktreeDataState;
  updateWorktreeDataState: (path: string, updates: Partial<WorktreeDataState>) => void;
}
```

**Default data state:**
```typescript
const defaultWorktreeDataState: WorktreeDataState = {
  ptySessionId: null,
  commits: [],
  changedFiles: [],
  baseBranch: null,
  diffText: null,
  fileDiffs: {},
  annotations: [],
};
```

## Startup Restoration Flow

All restoration logic lives in the Sidebar component (which already owns project/worktree loading):

1. App mounts → `uiStore` hydrated from localStorage automatically by Zustand persist middleware
2. Sidebar's `useEffect` loads `projects` from Tauri (`load_projects`) into `dataStore`
3. If `uiStore.selectedProject` is set → verify it exists in the loaded projects list. If not, clear `selectedProject` in uiStore and stop. If yes, auto-load worktrees for that project into `dataStore`.
4. If `uiStore.selectedWorktree` is set → verify it exists in the loaded worktrees list. If not, clear `selectedWorktree` in uiStore and stop. If yes, auto-select it: spawn PTY, start file watcher, load commits/baseBranch into `dataStore`.
5. CommitPanel reads `viewMode`/`selectedCommit` from `uiStore` nav state → if a `selectedCommit` is persisted, attempt to load its diff. If the commit no longer exists (e.g., amended/rebased), the Tauri command will fail — catch the error and clear `selectedCommit`/`viewMode` back to defaults.

**Key:** Steps 3-5 reuse the existing `selectProject`/`selectWorktree`/`selectCommit` functions with added validation that persisted references still exist. Stale references are silently cleared.

## Cross-Store Side Effects

Some actions need to update both stores atomically:

- **`setSelectedProject`** — sets `selectedProject` in uiStore, then clears `worktrees` and `selectedWorktree` in a coordinating function (not inside either store). The Sidebar's `selectProject` function already does this orchestration.
- **`removeProject`** — removes from `dataStore.projects`, clears `uiStore.selectedProject` if it matches, clears `dataStore.worktrees`. Again orchestrated in the Sidebar handler, not inside a store action.
- **`setSelectedWorktree`** — sets in uiStore, no dataStore side effect needed (data loading is async and happens after).

These are **not** store-internal actions — they're orchestrated by the component that triggers them, calling into both stores. This matches the current pattern where `selectProject` in Sidebar already calls multiple store methods sequentially.

## Component Store Usage

| Component | uiStore reads | uiStore writes | dataStore reads | dataStore writes |
|-----------|--------------|----------------|-----------------|------------------|
| App.tsx | selectedWorktree, nav (activeTab, showSplit) | setSelectedWorktree (clear) | — | nav (activeTab, showSplit) |
| Sidebar | selectedProject, selectedWorktree | setSelectedProject, setSelectedWorktree | projects, worktrees, worktreeDataStates (for commit counts) | setProjects, setWorktrees, updateWorktreeDataState |
| CommitPanel | nav (viewMode, selectedCommit, selectedFile) | updateWorktreeNavState | data (baseBranch, commits, changedFiles) | updateWorktreeDataState |
| DiffView | nav (viewMode, selectedCommit, selectedFile), diffStyle, wrap | setDiffStyle, setWrap | data (fileDiffs, diffText, annotations, changedFiles) | updateWorktreeDataState |

## Migration

The current `differ-ui-state` localStorage key stores `{ diffStyle, wrap }`. The new uiStore uses the same key but stores more fields. Zustand's persist middleware merges with defaults, so old persisted data works — `diffStyle` and `wrap` are preserved, new fields get defaults. No migration code needed.

## Files to Modify

| File | Change |
|------|--------|
| `apps/desktop/src/store.ts` | Split into `useUIStore` + `useDataStore` with separate types |
| `apps/desktop/src/types.ts` | Add `WorktreeNavState`, `WorktreeDataState`, remove old `WorktreeState` |
| `apps/desktop/src/App.tsx` | Use both stores, add startup restoration effect |
| `apps/desktop/src/components/Sidebar.tsx` | Use `useUIStore` for selections, `useDataStore` for projects/worktrees |
| `apps/desktop/src/components/CommitPanel.tsx` | Use both stores, split nav vs data reads/writes |
| `apps/desktop/src/components/DiffView.tsx` | Use both stores, split nav vs data reads/writes |

## What Stays the Same

- All Tauri commands and backend code
- SQLite providers (annotations, viewed files)
- Component structure and rendering logic
- All existing functionality
