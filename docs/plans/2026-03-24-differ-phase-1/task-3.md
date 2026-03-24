# Task 3: Three-Panel UI with Diff View

**Plan:** Differ Phase 1 — Walking Skeleton
**Goal:** Build the three-panel React UI — project/worktree sidebar, commit/file list, and diff view rendered by `@pierre/diffs`. User can open a folder, browse worktrees, select commits, and view file diffs.
**Depends on:** Task 2

**Files:**

- Create: `src/store.ts`, `src/components/Sidebar.tsx`, `src/components/CommitPanel.tsx`, `src/components/DiffView.tsx`, `src/types.ts`
- Modify: `src/App.tsx`

**Context:**

The Tauri backend (Task 2) exposes these commands via `invoke()`:
- `list_worktrees({ repoPath })` → `Worktree[]`
- `detect_base_branch({ worktreePath })` → `string`
- `get_diverged_commits({ worktreePath, baseBranch? })` → `CommitInfo[]`
- `get_changed_files({ worktreePath, commitHash })` → `ChangedFile[]`
- `get_commit_diff({ worktreePath, commitHash, filePath })` → `string` (raw unified diff)

The `@pierre/diffs` library is a React component imported from `@pierre/diffs/react`. Read its documentation at https://diffs.com/docs to understand the exact component API and props before implementing. The key props are likely `diff` (the raw unified diff string), `split` (boolean for side-by-side), and `wrap` (boolean for line wrapping).

**Steps:**

1. Create shared TypeScript types in `src/types.ts`:

```typescript
export interface Worktree {
  path: string;
  branch: string;
  head_commit: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}
```

2. Create the Zustand store in `src/store.ts`:

```typescript
import { create } from "zustand";
import type { Worktree, CommitInfo, ChangedFile } from "./types";

interface AppState {
  // Project
  repoPath: string | null;
  setRepoPath: (path: string) => void;

  // Worktrees
  worktrees: Worktree[];
  setWorktrees: (worktrees: Worktree[]) => void;
  selectedWorktree: Worktree | null;
  setSelectedWorktree: (worktree: Worktree | null) => void;

  // Commits
  baseBranch: string | null;
  setBaseBranch: (branch: string | null) => void;
  commits: CommitInfo[];
  setCommits: (commits: CommitInfo[]) => void;
  selectedCommit: CommitInfo | null;
  setSelectedCommit: (commit: CommitInfo | null) => void;

  // Changed files
  changedFiles: ChangedFile[];
  setChangedFiles: (files: ChangedFile[]) => void;
  selectedFile: ChangedFile | null;
  setSelectedFile: (file: ChangedFile | null) => void;

  // Diff
  diffText: string | null;
  setDiffText: (diff: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  repoPath: null,
  setRepoPath: (path) => set({ repoPath: path }),

  worktrees: [],
  setWorktrees: (worktrees) => set({ worktrees }),
  selectedWorktree: null,
  setSelectedWorktree: (worktree) =>
    set({ selectedWorktree: worktree, selectedCommit: null, changedFiles: [], selectedFile: null, diffText: null }),

  baseBranch: null,
  setBaseBranch: (branch) => set({ baseBranch: branch }),
  commits: [],
  setCommits: (commits) => set({ commits }),
  selectedCommit: null,
  setSelectedCommit: (commit) =>
    set({ selectedCommit: commit, selectedFile: null, diffText: null }),

  changedFiles: [],
  setChangedFiles: (files) => set({ changedFiles: files }),
  selectedFile: null,
  setSelectedFile: (file) => set({ selectedFile: file }),

  diffText: null,
  setDiffText: (diff) => set({ diffText: diff }),
}));
```

3. Create the Sidebar component in `src/components/Sidebar.tsx`. This shows the current project and its worktrees. It also has an "Open Project" button that uses Tauri's dialog API to pick a folder:

```tsx
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import type { Worktree } from "../types";

export function Sidebar() {
  const {
    repoPath, setRepoPath,
    worktrees, setWorktrees,
    selectedWorktree, setSelectedWorktree,
    setBaseBranch, setCommits,
  } = useAppStore();

  const openProject = async () => {
    const selected = await open({ directory: true });
    if (!selected) return;

    const path = selected as string;
    try {
      const wts = await invoke<Worktree[]>("list_worktrees", { repoPath: path });
      setRepoPath(path);
      setWorktrees(wts);
    } catch (e) {
      console.error("Not a git repository or no worktrees:", e);
    }
  };

  const selectWorktree = async (wt: Worktree) => {
    setSelectedWorktree(wt);
    try {
      const base = await invoke<string>("detect_base_branch", { worktreePath: wt.path });
      setBaseBranch(base);
      const commits = await invoke<any[]>("get_diverged_commits", {
        worktreePath: wt.path,
        baseBranch: base,
      });
      setCommits(commits);
    } catch (e) {
      console.error("Failed to load commits:", e);
    }
  };

  const projectName = repoPath ? repoPath.split("/").pop() : null;

  return (
    <div className="flex flex-col h-full w-56 min-w-56 border-r text-sm">
      {/* Projects */}
      <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b">
        Projects
      </div>
      {projectName && (
        <div className="px-3 py-1.5 font-semibold text-primary">{projectName}</div>
      )}

      {/* Worktrees */}
      {worktrees.length > 0 && (
        <>
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b mt-2">
            Worktrees
          </div>
          {worktrees.map((wt) => (
            <button
              key={wt.path}
              onClick={() => selectWorktree(wt)}
              className={`px-3 py-1.5 pl-5 text-left hover:bg-accent/10 ${
                selectedWorktree?.path === wt.path ? "bg-accent/10 text-primary font-semibold" : "text-muted-foreground"
              }`}
            >
              {wt.branch}
            </button>
          ))}
        </>
      )}

      <div className="flex-1" />
      <button
        onClick={openProject}
        className="px-3 py-2 border-t text-xs text-muted-foreground hover:text-primary"
      >
        + Open Project
      </button>
    </div>
  );
}
```

**Important:** This uses `@tauri-apps/plugin-dialog`. Install it:

```bash
cd /Users/sander/Projects/differ/differ && bun add @tauri-apps/plugin-dialog
cd /Users/sander/Projects/differ/differ/src-tauri && cargo add tauri-plugin-dialog
```

Register in `src-tauri/src/lib.rs` alongside existing plugins:

```rust
.plugin(tauri_plugin_dialog::init())
```

Add to `src-tauri/capabilities/default.json` permissions array:

```json
"dialog:default"
```

4. Create the CommitPanel component in `src/components/CommitPanel.tsx`:

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { ChangedFile } from "../types";

export function CommitPanel() {
  const {
    selectedWorktree,
    baseBranch,
    commits,
    selectedCommit, setSelectedCommit,
    changedFiles, setChangedFiles,
    selectedFile, setSelectedFile,
    setDiffText,
  } = useAppStore();

  if (!selectedWorktree) {
    return (
      <div className="flex items-center justify-center h-full w-64 min-w-64 border-r text-sm text-muted-foreground">
        Select a worktree
      </div>
    );
  }

  const selectCommit = async (commit: typeof commits[0]) => {
    setSelectedCommit(commit);
    try {
      const files = await invoke<ChangedFile[]>("get_changed_files", {
        worktreePath: selectedWorktree.path,
        commitHash: commit.hash,
      });
      setChangedFiles(files);
    } catch (e) {
      console.error("Failed to load changed files:", e);
    }
  };

  const selectFile = async (file: ChangedFile) => {
    setSelectedFile(file);
    if (!selectedCommit) return;
    try {
      const diff = await invoke<string>("get_commit_diff", {
        worktreePath: selectedWorktree.path,
        commitHash: selectedCommit.hash,
        filePath: file.path,
      });
      setDiffText(diff);
    } catch (e) {
      console.error("Failed to load diff:", e);
    }
  };

  const statusColor: Record<string, string> = {
    M: "text-green-500",
    A: "text-emerald-500",
    D: "text-red-500",
    R: "text-yellow-500",
  };

  return (
    <div className="flex flex-col h-full w-64 min-w-64 border-r text-sm">
      {/* Commits */}
      <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b">
        Commits on {selectedWorktree.branch}
      </div>
      {commits.length === 0 ? (
        <div className="px-3 py-4 text-muted-foreground text-xs">
          No commits ahead of {baseBranch}
        </div>
      ) : (
        <div className="overflow-y-auto">
          {commits.map((commit) => (
            <button
              key={commit.hash}
              onClick={() => selectCommit(commit)}
              className={`w-full px-3 py-2 text-left hover:bg-accent/10 ${
                selectedCommit?.hash === commit.hash ? "bg-accent/10 border-l-2 border-primary" : ""
              }`}
            >
              <div className="font-medium text-xs truncate">{commit.message}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {commit.hash.slice(0, 7)} · {commit.date.split("T")[0]}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Changed Files */}
      {changedFiles.length > 0 && (
        <>
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-t border-b">
            Changed Files
          </div>
          <div className="overflow-y-auto">
            {changedFiles.map((file) => (
              <button
                key={file.path}
                onClick={() => selectFile(file)}
                className={`w-full px-3 py-1.5 text-left font-mono text-xs hover:bg-accent/10 ${
                  selectedFile?.path === file.path ? "bg-accent/10 text-primary" : "text-muted-foreground"
                }`}
              >
                <span className={`mr-1.5 ${statusColor[file.status] || ""}`}>
                  {file.status}
                </span>
                {file.path.split("/").pop()}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

5. Create the DiffView component in `src/components/DiffView.tsx`. This is the key component that uses `@pierre/diffs`:

**Before implementing:** Read the `@pierre/diffs` documentation at https://diffs.com/docs to confirm the exact import path and component props. The component is likely imported from `@pierre/diffs/react`. Adapt the code below based on the actual API you find in the docs.

```tsx
import { useAppStore } from "../store";
// Import from @pierre/diffs/react — check docs for exact component name
// This is a placeholder that should be adapted to the actual API:
// import { DiffView as PierreDiff } from "@pierre/diffs/react";

export function DiffView() {
  const { selectedFile, diffText } = useAppStore();

  if (!selectedFile || !diffText) {
    return (
      <div className="flex items-center justify-center h-full flex-1 text-sm text-muted-foreground">
        Select a file to view its diff
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full flex-1 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b">
        <span className="font-mono font-semibold text-xs">{selectedFile.path}</span>
      </div>

      {/* Diff content — integrate @pierre/diffs here */}
      <div className="flex-1 overflow-auto">
        {/*
          Replace this with the actual @pierre/diffs component.
          Read https://diffs.com/docs for the component API.

          Expected usage (adapt to actual API):
          <PierreDiff diff={diffText} split={true} wrap={false} />
        */}
        <pre className="p-4 text-xs font-mono whitespace-pre overflow-x-auto">
          {diffText}
        </pre>
      </div>
    </div>
  );
}
```

**Important:** The exact `@pierre/diffs` API must be confirmed by reading the docs. The implementer MUST:
1. Fetch https://diffs.com/docs to understand the component API
2. Check `node_modules/@pierre/diffs` for the actual exports
3. Replace the `<pre>` placeholder with the real Pierre component

If the Pierre component requires a highlighter instance, create one following their docs (likely involves `createHighlighter` from `@pierre/diffs`).

6. Update `src/App.tsx` to compose the three panels:

```tsx
import { Sidebar } from "./components/Sidebar";
import { CommitPanel } from "./components/CommitPanel";
import { DiffView } from "./components/DiffView";

function App() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <CommitPanel />
      <DiffView />
    </div>
  );
}

export default App;
```

7. Verify the app builds and runs:

```bash
cd /Users/sander/Projects/differ/differ && bun run tauri dev
```

Expected: The app opens. Click "Open Project", select a git repository that has worktrees. The sidebar populates with worktrees. Click a worktree to see diverged commits. Click a commit to see changed files. Click a file to see its diff (as raw text initially, or rendered by Pierre if the integration is complete).

8. Commit:

```bash
cd /Users/sander/Projects/differ/differ
git add src/types.ts src/store.ts src/components/ src/App.tsx src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: add three-panel UI with worktree browsing and diff view"
```

**Done When:**

- [ ] Three-panel layout renders correctly
- [ ] "Open Project" opens a folder picker and loads worktrees
- [ ] Selecting a worktree shows diverged commits
- [ ] Selecting a commit shows changed files
- [ ] Selecting a file shows the diff (at minimum as raw text; ideally via `@pierre/diffs`)
- [ ] No TypeScript errors
- [ ] Committed
