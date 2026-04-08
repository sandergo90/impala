import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Worktree, Project, WorktreeNavState, WorktreeDataState } from "./types";
import type { Theme } from "./themes/types";
import { defaultDark } from "./themes/built-in";
import { applyTheme, initThemeFromStore, resolveThemeById } from "./themes/apply";
import { createLeaf } from "./lib/split-tree";

export interface FloatingTerminalState {
  mode: 'hidden' | 'expanded' | 'pill';
  sessionId: string | null;
  label: string;
  type: 'setup' | 'run' | null;
  status: 'running' | 'succeeded' | 'failed';
}

const defaultFloatingTerminal: FloatingTerminalState = {
  mode: 'hidden',
  sessionId: null,
  label: '',
  type: null,
  status: 'running',
};

function createDefaultNavState(): WorktreeNavState {
  const leaf = createLeaf("claude");
  return {
    activeTab: "diff",
    splitTree: leaf,
    focusedPaneId: leaf.id,
    claudeLaunched: false,
    viewMode: "commit",
    selectedCommit: null,
    selectedFile: null,
  };
}

const defaultDataState: WorktreeDataState = {
  paneSessions: {},
  commits: [],
  changedFiles: [],
  baseBranch: null,
  diffText: null,
  fileDiffs: {},
  fileDiffHashes: {},
  generatedFiles: [],
  annotations: [],
  agentStatus: "idle" as const,
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
  showResolved: boolean;
  setShowResolved: (show: boolean) => void;
  floatingTerminals: Record<string, FloatingTerminalState>;
  getFloatingTerminal: (worktreePath: string) => FloatingTerminalState;
  setFloatingTerminal: (worktreePath: string, updates: Partial<FloatingTerminalState>) => void;
  floatingTerminalSize: { width: number; height: number };
  setFloatingTerminalSize: (size: { width: number; height: number }) => void;
  linearApiKey: string;
  setLinearApiKey: (key: string) => void;
  preferredEditor: string;
  setPreferredEditor: (editor: string) => void;
  notificationSoundMuted: boolean;
  setNotificationSoundMuted: (muted: boolean) => void;
  selectedSoundId: string;
  setSelectedSoundId: (id: string) => void;
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
        const stored = get().worktreeNavStates[path];
        if (!stored) return createDefaultNavState();
        const defaults = createDefaultNavState();
        // Merge with defaults to handle old persisted state missing new fields (splitTree, focusedPaneId)
        return {
          ...defaults,
          ...Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined)),
        } as WorktreeNavState;
      },
      updateWorktreeNavState: (path: string, updates: Partial<WorktreeNavState>) =>
        set((state) => {
          const current = state.worktreeNavStates[path] ?? { ...createDefaultNavState() };
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
        applyTheme(resolveThemeById(id, get().customThemes));
      },
      customThemes: [],
      addCustomTheme: (theme) =>
        set((state) => ({
          customThemes: [...state.customThemes, theme],
        })),
      removeCustomTheme: (id) => {
        const wasActive = get().activeThemeId === id;
        set((state) => ({
          customThemes: state.customThemes.filter((t) => t.id !== id),
          activeThemeId: wasActive ? "default-dark" : state.activeThemeId,
        }));
        if (wasActive) applyTheme(defaultDark);
      },
      showResolved: false,
      setShowResolved: (show) => set({ showResolved: show }),
      floatingTerminals: {},
      getFloatingTerminal: (worktreePath: string): FloatingTerminalState => {
        return get().floatingTerminals[worktreePath] ?? defaultFloatingTerminal;
      },
      setFloatingTerminal: (worktreePath: string, updates: Partial<FloatingTerminalState>) =>
        set((state) => {
          const current = state.floatingTerminals[worktreePath] ?? { ...defaultFloatingTerminal };
          return {
            floatingTerminals: {
              ...state.floatingTerminals,
              [worktreePath]: { ...current, ...updates },
            },
          };
        }),
      floatingTerminalSize: { width: 500, height: 300 },
      setFloatingTerminalSize: (size) => set({ floatingTerminalSize: size }),
      linearApiKey: "",
      setLinearApiKey: (key) => set({ linearApiKey: key }),
      preferredEditor: "cursor",
      setPreferredEditor: (editor) => set({ preferredEditor: editor }),
      notificationSoundMuted: false,
      setNotificationSoundMuted: (muted) => set({ notificationSoundMuted: muted }),
      selectedSoundId: "chime",
      setSelectedSoundId: (id) => set({ selectedSoundId: id }),
    }),
    {
      name: "canopy-ui-state",
      partialize: (state) => {
        const { showResolved, floatingTerminals, ...rest } = state;
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
