import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Worktree, Project, WorktreeNavState, WorktreeDataState } from "./types";
import type { Theme } from "./themes/types";
import { getBuiltInTheme, defaultDark } from "./themes/built-in";
import { applyTheme, initThemeFromStore } from "./themes/apply";

const defaultNavState: WorktreeNavState = {
  activeTab: 'diff',
  showSplit: false,
  viewMode: 'commit',
  selectedCommit: null,
  selectedFile: null,
};

const defaultDataState: WorktreeDataState = {
  ptySessionId: null,
  commits: [],
  changedFiles: [],
  baseBranch: null,
  diffText: null,
  fileDiffs: {},
  annotations: [],
};

interface UIState {
  selectedProject: Project | null;
  setSelectedProject: (project: Project | null) => void;
  selectedWorktree: Worktree | null;
  setSelectedWorktree: (worktree: Worktree | null) => void;
  diffStyle: 'split' | 'unified';
  setDiffStyle: (style: 'split' | 'unified') => void;
  wrap: boolean;
  setWrap: (wrap: boolean) => void;
  worktreeNavStates: Record<string, WorktreeNavState>;
  getWorktreeNavState: (path: string) => WorktreeNavState;
  updateWorktreeNavState: (path: string, updates: Partial<WorktreeNavState>) => void;
  activeThemeId: string;
  setActiveThemeId: (id: string) => void;
  customThemes: Theme[];
  addCustomTheme: (theme: Theme) => void;
  removeCustomTheme: (id: string) => void;
  currentView: 'main' | 'settings';
  setCurrentView: (view: 'main' | 'settings') => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      selectedProject: null,
      setSelectedProject: (project) => set({ selectedProject: project }),
      selectedWorktree: null,
      setSelectedWorktree: (worktree) => set({ selectedWorktree: worktree }),
      diffStyle: 'split',
      setDiffStyle: (style) => set({ diffStyle: style }),
      wrap: false,
      setWrap: (wrap) => set({ wrap }),
      worktreeNavStates: {},
      getWorktreeNavState: (path: string): WorktreeNavState => {
        return get().worktreeNavStates[path] ?? defaultNavState;
      },
      updateWorktreeNavState: (path: string, updates: Partial<WorktreeNavState>) =>
        set((state) => {
          const current = state.worktreeNavStates[path] ?? { ...defaultNavState };
          return {
            worktreeNavStates: {
              ...state.worktreeNavStates,
              [path]: { ...current, ...updates },
            },
          };
        }),
      activeThemeId: "default-dark",
      setActiveThemeId: (id) => {
        set({ activeThemeId: id });
        const theme = getBuiltInTheme(id) ?? get().customThemes.find((t) => t.id === id) ?? defaultDark;
        applyTheme(theme);
      },
      customThemes: [],
      addCustomTheme: (theme) =>
        set((state) => ({
          customThemes: [...state.customThemes, theme],
        })),
      removeCustomTheme: (id) =>
        set((state) => ({
          customThemes: state.customThemes.filter((t) => t.id !== id),
          activeThemeId: state.activeThemeId === id ? "default-dark" : state.activeThemeId,
        })),
      currentView: 'main',
      setCurrentView: (view) => set({ currentView: view }),
    }),
    {
      name: "differ-ui-state",
      partialize: (state) => {
        const { currentView, ...rest } = state;
        return rest;
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          initThemeFromStore(state.activeThemeId, state.customThemes);
        }
      },
    }
  )
);

interface DataState {
  projects: Project[];
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (path: string) => void;
  worktrees: Worktree[];
  setWorktrees: (worktrees: Worktree[]) => void;
  worktreeDataStates: Record<string, WorktreeDataState>;
  getWorktreeDataState: (path: string) => WorktreeDataState;
  updateWorktreeDataState: (path: string, updates: Partial<WorktreeDataState>) => void;
}

export const useDataStore = create<DataState>()(
  (set, get) => ({
    projects: [],
    setProjects: (projects) => set({ projects }),
    addProject: (project) =>
      set((state) => {
        if (state.projects.some((p) => p.path === project.path)) return state;
        return { projects: [...state.projects, project] };
      }),
    removeProject: (path) =>
      set((state) => ({
        projects: state.projects.filter((p) => p.path !== path),
      })),
    worktrees: [],
    setWorktrees: (worktrees) => set({ worktrees }),
    worktreeDataStates: {},
    getWorktreeDataState: (path: string): WorktreeDataState => {
      return get().worktreeDataStates[path] ?? defaultDataState;
    },
    updateWorktreeDataState: (path: string, updates: Partial<WorktreeDataState>) =>
      set((state) => {
        const current = state.worktreeDataStates[path] ?? { ...defaultDataState };
        return {
          worktreeDataStates: {
            ...state.worktreeDataStates,
            [path]: { ...current, ...updates },
          },
        };
      }),
  })
);
