import { create } from "zustand";
import type { Worktree, CommitInfo, ChangedFile } from "./types";

interface AppState {
  repoPath: string | null;
  setRepoPath: (path: string) => void;
  worktrees: Worktree[];
  setWorktrees: (worktrees: Worktree[]) => void;
  selectedWorktree: Worktree | null;
  setSelectedWorktree: (worktree: Worktree | null) => void;
  baseBranch: string | null;
  setBaseBranch: (branch: string | null) => void;
  commits: CommitInfo[];
  setCommits: (commits: CommitInfo[]) => void;
  selectedCommit: CommitInfo | null;
  setSelectedCommit: (commit: CommitInfo | null) => void;
  changedFiles: ChangedFile[];
  setChangedFiles: (files: ChangedFile[]) => void;
  selectedFile: ChangedFile | null;
  setSelectedFile: (file: ChangedFile | null) => void;
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
