import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Worktree, CommitInfo, ChangedFile, Project, Annotation } from "./types";

interface AppState {
  // Projects (multi)
  projects: Project[];
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (path: string) => void;
  selectedProject: Project | null;
  setSelectedProject: (project: Project | null) => void;

  // Worktrees & git state
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
  fileDiffs: Record<string, string>;
  setFileDiffs: (diffs: Record<string, string>) => void;

  // Diff view settings
  diffStyle: 'split' | 'unified';
  setDiffStyle: (style: 'split' | 'unified') => void;
  wrap: boolean;
  setWrap: (wrap: boolean) => void;
  viewMode: 'commit' | 'all-changes';
  setViewMode: (mode: 'commit' | 'all-changes') => void;

  // Annotations
  annotations: Annotation[];
  setAnnotations: (annotations: Annotation[]) => void;
  addAnnotation: (annotation: Annotation) => void;
  updateAnnotation: (id: string, updated: Annotation) => void;
  removeAnnotation: (id: string) => void;

  // Terminal
  activeTab: 'terminal' | 'diff';
  setActiveTab: (tab: 'terminal' | 'diff') => void;
  ptySessionId: string | null;
  setPtySessionId: (id: string | null) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
  // Projects
  projects: [],
  setProjects: (projects) => set({ projects }),
  addProject: (project) =>
    set((state) => {
      if (state.projects.some((p) => p.path === project.path)) return state;
      return { projects: [...state.projects, project] };
    }),
  removeProject: (path) =>
    set((state) => {
      const projects = state.projects.filter((p) => p.path !== path);
      const selectedProject =
        state.selectedProject?.path === path ? null : state.selectedProject;
      return {
        projects,
        selectedProject,
        ...(state.selectedProject?.path === path
          ? {
              worktrees: [],
              selectedWorktree: null,
              baseBranch: null,
              commits: [],
              selectedCommit: null,
              changedFiles: [],
              selectedFile: null,
              diffText: null,
            }
          : {}),
      };
    }),
  selectedProject: null,
  setSelectedProject: (project) =>
    set({
      selectedProject: project,
      worktrees: [],
      selectedWorktree: null,
      baseBranch: null,
      commits: [],
      selectedCommit: null,
      changedFiles: [],
      selectedFile: null,
      diffText: null,
      fileDiffs: {},
    }),

  // Worktrees & git state
  worktrees: [],
  setWorktrees: (worktrees) => set({ worktrees }),
  selectedWorktree: null,
  setSelectedWorktree: (worktree) =>
    set({
      selectedWorktree: worktree,
      selectedCommit: null,
      changedFiles: [],
      selectedFile: null,
      diffText: null,
      fileDiffs: {},
    }),
  baseBranch: null,
  setBaseBranch: (branch) => set({ baseBranch: branch }),
  commits: [],
  setCommits: (commits) => set({ commits }),
  selectedCommit: null,
  setSelectedCommit: (commit) =>
    set({ selectedCommit: commit, selectedFile: null, diffText: null, fileDiffs: {} }),
  changedFiles: [],
  setChangedFiles: (files) => set({ changedFiles: files }),
  selectedFile: null,
  setSelectedFile: (file) => set({ selectedFile: file }),
  diffText: null,
  setDiffText: (diff) => set({ diffText: diff }),
  fileDiffs: {},
  setFileDiffs: (diffs) => set({ fileDiffs: diffs }),

  // Diff view settings
  diffStyle: 'split',
  setDiffStyle: (style) => set({ diffStyle: style }),
  wrap: false,
  setWrap: (wrap) => set({ wrap }),
  viewMode: 'commit',
  setViewMode: (mode) => set({ viewMode: mode }),

  // Annotations
  annotations: [],
  setAnnotations: (annotations) => set({ annotations }),
  addAnnotation: (annotation) =>
    set((state) => ({ annotations: [...state.annotations, annotation] })),
  updateAnnotation: (id, updated) =>
    set((state) => ({
      annotations: state.annotations.map((a) => (a.id === id ? updated : a)),
    })),
  removeAnnotation: (id) =>
    set((state) => ({
      annotations: state.annotations.filter((a) => a.id !== id),
    })),

  // Terminal (not persisted)
  activeTab: 'diff',
  setActiveTab: (tab) => set({ activeTab: tab }),
  ptySessionId: null,
  setPtySessionId: (id) => set({ ptySessionId: id }),
    }),
    {
      name: "differ-ui-state",
      partialize: (state) => ({
        diffStyle: state.diffStyle,
        wrap: state.wrap,
      }),
    }
  )
);
