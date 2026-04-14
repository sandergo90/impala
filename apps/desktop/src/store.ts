import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Worktree, Project, WorktreeNavState, WorktreeDataState, SplitNode } from "./types";
import type { Theme } from "./themes/types";
import { defaultDark } from "./themes/built-in";
import { applyTheme, initThemeFromStore, resolveThemeById } from "./themes/apply";
import { createLeaf } from "./lib/split-tree";

function createDefaultNavState(): WorktreeNavState {
  return {
    activeTab: "terminal",
    claudeLaunched: false,
    viewMode: "commit",
    selectedCommit: null,
    selectedFile: null,
    activePlanId: null,
    selectedPlanAnnotationId: null,
    activeTerminalsTab: "tab-claude",
    setupRanAt: null,
    runStatus: "idle",
    userTabs: [],
    tabCounters: { terminal: 1, claude: 2 },
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
  uncommittedStats: { additions: 0, deletions: 0 },
  allChangesStats: { additions: 0, deletions: 0 },
  annotations: [],
  plans: [],
  planAnnotations: [],
  hasPendingPlan: false,
  agentStatus: "idle" as const,
  hasUnseenResult: false,
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
      version: 1,
      migrate: (persistedState: any, fromVersion: number) => {
        if (fromVersion < 1 && persistedState?.worktreeNavStates) {
          const cleaned: Record<string, any> = {};
          for (const [path, nav] of Object.entries(persistedState.worktreeNavStates)) {
            const { splitTree, focusedPaneId, ...rest } = nav as Record<string, unknown>;
            cleaned[path] = rest;
          }
          persistedState.worktreeNavStates = cleaned;
        }
        return persistedState;
      },
      partialize: (state) => {
        const {
          showResolved,
          generalTerminalActive,
          previousWorktree,
          generalTerminalSplitTree,
          generalTerminalFocusedPaneId,
          linearApiKey,
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
