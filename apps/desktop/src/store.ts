import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Worktree, Project, WorktreeState } from "./types";

const defaultWorktreeState: WorktreeState = {
  ptySessionId: null, activeTab: 'diff', showSplit: true,
  commits: [], selectedCommit: null, changedFiles: [],
  selectedFile: null, diffText: null, fileDiffs: {},
  baseBranch: null, viewMode: 'commit', annotations: [],
  viewedFiles: [],
};

interface AppState {
  // Projects (multi)
  projects: Project[];
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (path: string) => void;
  selectedProject: Project | null;
  setSelectedProject: (project: Project | null) => void;

  // Worktrees
  worktrees: Worktree[];
  setWorktrees: (worktrees: Worktree[]) => void;
  selectedWorktree: Worktree | null;
  setSelectedWorktree: (worktree: Worktree | null) => void;

  // Per-worktree state
  worktreeStates: Record<string, WorktreeState>;
  getWorktreeState: (path: string) => WorktreeState;
  updateWorktreeState: (path: string, updates: Partial<WorktreeState>) => void;

  // Diff view settings (global)
  diffStyle: 'split' | 'unified';
  setDiffStyle: (style: 'split' | 'unified') => void;
  wrap: boolean;
  setWrap: (wrap: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
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
    }),

  // Worktrees
  worktrees: [],
  setWorktrees: (worktrees) => set({ worktrees }),
  selectedWorktree: null,
  setSelectedWorktree: (worktree) =>
    set({
      selectedWorktree: worktree,
    }),

  // Per-worktree state
  worktreeStates: {},
  getWorktreeState: (path: string): WorktreeState => {
    return get().worktreeStates[path] ?? defaultWorktreeState;
  },
  updateWorktreeState: (path: string, updates: Partial<WorktreeState>) =>
    set((state) => {
      const current = state.worktreeStates[path] ?? { ...defaultWorktreeState };
      return {
        worktreeStates: {
          ...state.worktreeStates,
          [path]: { ...current, ...updates },
        },
      };
    }),

  // Diff view settings
  diffStyle: 'split',
  setDiffStyle: (style) => set({ diffStyle: style }),
  wrap: false,
  setWrap: (wrap) => set({ wrap }),
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
