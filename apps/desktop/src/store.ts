import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Worktree, Project, WorktreeNavState, WorktreeDataState, SplitNode } from "./types";
import type { Theme } from "./themes/types";
import { defaultDark } from "./themes/built-in";
import { applyTheme, initThemeFromStore, resolveThemeById } from "./themes/apply";
import { createLeaf } from "./lib/split-tree";

export interface FloatingTerminalState {
  mode: 'hidden' | 'expanded' | 'pill';
  sessionId: string | null;
  label: string;
  type: 'setup' | 'run' | null;
  status: 'running' | 'stopping' | 'stopped' | 'succeeded' | 'failed';
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
    activeTab: "terminal",
    splitTree: leaf,
    focusedPaneId: leaf.id,
    claudeLaunched: false,
    viewMode: "commit",
    selectedCommit: null,
    selectedFile: null,
  };
}

const defaultGeneralTerminalLeaf = createLeaf("shell");

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
  floatingTerminalPosition: { x: number; y: number } | null;
  setFloatingTerminalPosition: (pos: { x: number; y: number } | null) => void;
  linearApiKey: string;
  setLinearApiKey: (key: string) => void;
  preferredEditor: string;
  setPreferredEditor: (editor: string) => void;
  notificationSoundMuted: boolean;
  setNotificationSoundMuted: (muted: boolean) => void;
  selectedSoundId: string;
  setSelectedSoundId: (id: string) => void;
  sidebarSize: number | null;
  setSidebarSize: (size: number | null) => void;
  rightSidebarSize: number | null;
  setRightSidebarSize: (size: number | null) => void;
  fontSize: number;
  setFontSize: (size: number) => void;
  editorFontFamily: string | null;
  setEditorFontFamily: (family: string | null) => void;
  editorFontSize: number | null;
  setEditorFontSize: (size: number | null) => void;
  terminalFontFamily: string | null;
  setTerminalFontFamily: (family: string | null) => void;
  terminalFontSize: number | null;
  setTerminalFontSize: (size: number | null) => void;
  // General terminal
  generalTerminalActive: boolean;
  setGeneralTerminalActive: (active: boolean) => void;
  generalTerminalSplitTree: SplitNode;
  setGeneralTerminalSplitTree: (tree: SplitNode) => void;
  generalTerminalFocusedPaneId: string;
  setGeneralTerminalFocusedPaneId: (id: string) => void;
  previousWorktree: Worktree | null;
  setPreviousWorktree: (worktree: Worktree | null) => void;
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
      floatingTerminalPosition: null,
      setFloatingTerminalPosition: (pos) => set({ floatingTerminalPosition: pos }),
      linearApiKey: "",
      setLinearApiKey: (key) => set({ linearApiKey: key }),
      preferredEditor: "cursor",
      setPreferredEditor: (editor) => set({ preferredEditor: editor }),
      notificationSoundMuted: false,
      setNotificationSoundMuted: (muted) => set({ notificationSoundMuted: muted }),
      selectedSoundId: "chime",
      setSelectedSoundId: (id) => set({ selectedSoundId: id }),
      sidebarSize: null,
      setSidebarSize: (size) => set({ sidebarSize: size }),
      rightSidebarSize: null,
      setRightSidebarSize: (size) => set({ rightSidebarSize: size }),
      fontSize: 14,
      setFontSize: (size) => {
        set({ fontSize: size });
        document.documentElement.style.fontSize = `${size}px`;
      },
      editorFontFamily: null,
      setEditorFontFamily: (family) => set({ editorFontFamily: family }),
      editorFontSize: null,
      setEditorFontSize: (size) => set({ editorFontSize: size }),
      terminalFontFamily: null,
      setTerminalFontFamily: (family) => set({ terminalFontFamily: family }),
      terminalFontSize: null,
      setTerminalFontSize: (size) => set({ terminalFontSize: size }),
      generalTerminalActive: false,
      setGeneralTerminalActive: (active) => set({ generalTerminalActive: active }),
      generalTerminalSplitTree: defaultGeneralTerminalLeaf,
      setGeneralTerminalSplitTree: (tree) => set({ generalTerminalSplitTree: tree }),
      generalTerminalFocusedPaneId: defaultGeneralTerminalLeaf.id,
      setGeneralTerminalFocusedPaneId: (id) => set({ generalTerminalFocusedPaneId: id }),
      previousWorktree: null,
      setPreviousWorktree: (worktree) => set({ previousWorktree: worktree }),
    }),
    {
      name: "impala-ui-state",
      partialize: (state) => {
        const {
          showResolved,
          floatingTerminals,
          generalTerminalActive,
          previousWorktree,
          generalTerminalSplitTree,
          generalTerminalFocusedPaneId,
          ...rest
        } = state;
        return rest;
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          initThemeFromStore(state.activeThemeId, state.customThemes);
          document.documentElement.style.fontSize = `${state.fontSize ?? 14}px`;
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
  projectIcons: Record<string, string>;
  setProjectIcon: (path: string, dataUrl: string) => void;
  worktreeDataStates: Record<string, WorktreeDataState>;
  getWorktreeDataState: (path: string) => WorktreeDataState;
  updateWorktreeDataState: (path: string, updates: Partial<WorktreeDataState>) => void;
  generalTerminalPaneSessions: Record<string, string>;
  setGeneralTerminalPaneSessions: (sessions: Record<string, string>) => void;
  updateGeneralTerminalPaneSession: (paneId: string, sessionId: string) => void;
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
    projectIcons: {},
    setProjectIcon: (path, dataUrl) =>
      set((state) => ({
        projectIcons: { ...state.projectIcons, [path]: dataUrl },
      })),
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
    generalTerminalPaneSessions: {},
    setGeneralTerminalPaneSessions: (sessions) => set({ generalTerminalPaneSessions: sessions }),
    updateGeneralTerminalPaneSession: (paneId, sessionId) =>
      set((state) => ({
        generalTerminalPaneSessions: { ...state.generalTerminalPaneSessions, [paneId]: sessionId },
      })),
  })
);
