import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Worktree, Project, WorktreeNavState, WorktreeDataState, SplitNode, Action } from "./types";
import type { Theme, VibrancyMaterial } from "./themes/types";
import { defaultDark } from "./themes/built-in";
import { applyTheme, applyWindowVibrancy, initThemeFromStore, resolveThemeById } from "./themes/apply";
import { createLeaf } from "./lib/split-tree";

function createDefaultNavState(): WorktreeNavState {
  return {
    activeTab: "terminal",
    agentLaunched: false,
    viewMode: "commit",
    selectedCommit: null,
    selectedFile: null,
    activeTerminalsTab: "tab-agent",
    setupRanAt: null,
    runStatus: "idle",
    userTabs: [],
    tabHistory: [],
    runExitCode: null,
    hasUnreadRunFailure: false,
    lastUsedActionId: null,
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
  generatedFiles: [],
  uncommittedStats: { additions: 0, deletions: 0 },
  allChangesStats: { additions: 0, deletions: 0 },
  lastTurnStats: { additions: 0, deletions: 0 },
  hasLastTurnSnapshot: false,
  annotations: [],
  agentStatus: "idle" as const,
  hasUnseenResult: false,
};

interface UIState {
  selectedProject: Project | null;
  setSelectedProject: (project: Project | null) => void;
  // The project the user was on before the current one, so they can quickly
  // toggle back. Not persisted (session-only, mirrors previousWorktree).
  previousProject: Project | null;
  setPreviousProject: (project: Project | null) => void;
  selectedWorktree: Worktree | null;
  setSelectedWorktree: (worktree: Worktree | null) => void;
  // Last selected worktree path per project path, so switching projects can
  // restore the worktree the user was last on in that project. Persisted.
  lastWorktreeByProject: Record<string, string>;
  setLastWorktreeForProject: (projectPath: string, worktreePath: string) => void;
  diffStyle: 'split' | 'unified';
  setDiffStyle: (style: 'split' | 'unified') => void;
  wrap: boolean;
  setWrap: (wrap: boolean) => void;
  hideViewed: boolean;
  setHideViewed: (hide: boolean) => void;
  worktreeNavStates: Record<string, WorktreeNavState>;
  getWorktreeNavState: (path: string) => WorktreeNavState;
  updateWorktreeNavState: (path: string, updates: Partial<WorktreeNavState>) => void;
  activeThemeId: string;
  setActiveThemeId: (id: string) => void;
  customThemes: Theme[];
  addCustomTheme: (theme: Theme) => void;
  removeCustomTheme: (id: string) => void;
  windowVibrancy: VibrancyMaterial;
  setWindowVibrancy: (material: VibrancyMaterial) => void;
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
  sidebarWidth: number | null;
  setSidebarWidth: (width: number | null) => void;
  rightSidebarWidth: number | null;
  setRightSidebarWidth: (width: number | null) => void;
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
  worktreeExpandedDirs: Record<string, string[]>;
  setWorktreeExpandedDirs: (worktreePath: string, dirs: string[]) => void;
  pendingTreeReveal: { worktreePath: string; path: string; nonce: number } | null;
  revealFileInTree: (worktreePath: string, path: string) => void;
  fileFinderOpen: boolean;
  setFileFinderOpen: (open: boolean) => void;
  // In-memory; lifted out of App.tsx so the native browser webview can hide
  // beneath the palette (BrowserPane occlusion).
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  // True while a sidebar edge drag is in progress. The native browser webview
  // hides during drags so the cursor never gets captured by it mid-drag.
  panelDragActive: boolean;
  setPanelDragActive: (active: boolean) => void;
  // Whether the sidebar (and other worktree consumers) hides worktrees that
  // live outside the configured worktree base directory. Persisted.
  worktreeFilterEnabled: boolean;
  setWorktreeFilterEnabled: (enabled: boolean) => void;
  // Mirror of the DB-backed `worktreeBaseDir` setting + the platform default,
  // populated at app boot. Not persisted (the DB / backend are authoritative).
  worktreeBaseDirOverride: string | null;
  setWorktreeBaseDirOverride: (path: string | null) => void;
  worktreeDefaultBaseDir: string | null;
  setWorktreeDefaultBaseDir: (path: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      selectedProject: null,
      setSelectedProject: (project) => set({ selectedProject: project }),
      previousProject: null,
      setPreviousProject: (project) => set({ previousProject: project }),
      selectedWorktree: null,
      setSelectedWorktree: (worktree) => set({ selectedWorktree: worktree }),
      lastWorktreeByProject: {},
      setLastWorktreeForProject: (projectPath, worktreePath) =>
        set((state) => ({
          lastWorktreeByProject: {
            ...state.lastWorktreeByProject,
            [projectPath]: worktreePath,
          },
        })),
      diffStyle: 'split',
      setDiffStyle: (style) => set({ diffStyle: style }),
      wrap: false,
      setWrap: (wrap) => set({ wrap }),
      hideViewed: false,
      setHideViewed: (hide) => set({ hideViewed: hide }),
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
          const merged = { ...current, ...updates };
          // Auto-track tab visit history. Skipped when the caller passes
          // `tabHistory` explicitly (e.g. closeUserTab needs to strip the
          // closed tab from history at the same moment it switches active).
          if (
            "activeTerminalsTab" in updates &&
            updates.activeTerminalsTab !== current.activeTerminalsTab &&
            !("tabHistory" in updates)
          ) {
            const nextActive = updates.activeTerminalsTab as string;
            const existing = current.tabHistory ?? [];
            const filtered = existing.filter((id) => id !== nextActive);
            merged.tabHistory = [...filtered, current.activeTerminalsTab].slice(-20);
          }
          return {
            worktreeNavStates: {
              ...state.worktreeNavStates,
              [path]: merged,
            },
          };
        }),
      activeThemeId: "default-dark",
      setActiveThemeId: (id) => {
        set({ activeThemeId: id });
        applyTheme(resolveThemeById(id, get().customThemes), get().windowVibrancy);
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
        if (wasActive) applyTheme(defaultDark, get().windowVibrancy);
      },
      windowVibrancy: "off",
      setWindowVibrancy: (material) => {
        set({ windowVibrancy: material });
        const theme = resolveThemeById(get().activeThemeId, get().customThemes);
        applyTheme(theme, material);
        void applyWindowVibrancy(material);
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
      sidebarWidth: null,
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      rightSidebarWidth: null,
      setRightSidebarWidth: (width) => set({ rightSidebarWidth: width }),
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
      worktreeExpandedDirs: {},
      setWorktreeExpandedDirs: (worktreePath, dirs) =>
        set((state) => ({
          worktreeExpandedDirs: {
            ...state.worktreeExpandedDirs,
            [worktreePath]: dirs,
          },
        })),
      pendingTreeReveal: null,
      revealFileInTree: (worktreePath, path) =>
        set({ pendingTreeReveal: { worktreePath, path, nonce: Date.now() } }),
      fileFinderOpen: false,
      setFileFinderOpen: (open) => set({ fileFinderOpen: open }),
      commandPaletteOpen: false,
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
      panelDragActive: false,
      setPanelDragActive: (active) => set({ panelDragActive: active }),
      worktreeFilterEnabled: true,
      setWorktreeFilterEnabled: (enabled) => set({ worktreeFilterEnabled: enabled }),
      worktreeBaseDirOverride: null,
      setWorktreeBaseDirOverride: (path) => set({ worktreeBaseDirOverride: path }),
      worktreeDefaultBaseDir: null,
      setWorktreeDefaultBaseDir: (path) => set({ worktreeDefaultBaseDir: path }),
    }),
    {
      name: "impala-ui-state",
      version: 6,
      migrate: (persistedState: any, fromVersion: number) => {
        if (fromVersion < 1 && persistedState?.worktreeNavStates) {
          const cleaned: Record<string, any> = {};
          for (const [path, nav] of Object.entries(persistedState.worktreeNavStates)) {
            const { splitTree, focusedPaneId, ...rest } = nav as Record<string, unknown>;
            cleaned[path] = rest;
          }
          persistedState.worktreeNavStates = cleaned;
        }
        if (fromVersion < 2 && persistedState) {
          // v1 stored percentages under sidebarSize/rightSidebarSize for
          // react-resizable-panels. v2 stores pixels under sidebarWidth/
          // rightSidebarWidth. Drop the legacy fields and let defaults apply.
          delete persistedState.sidebarSize;
          delete persistedState.rightSidebarSize;
        }
        if (fromVersion < 3 && persistedState?.worktreeNavStates) {
          for (const nav of Object.values(persistedState.worktreeNavStates) as any[]) {
            if (nav && typeof nav.claudeLaunched === "boolean") {
              nav.agentLaunched = nav.claudeLaunched;
              delete nav.claudeLaunched;
            }
          }
        }
        if (fromVersion < 4 && persistedState?.worktreeNavStates) {
          for (const nav of Object.values(persistedState.worktreeNavStates) as any[]) {
            if (nav?.activeTerminalsTab === "tab-claude") {
              nav.activeTerminalsTab = "tab-agent";
            }
          }
        }
        if (fromVersion < 5 && persistedState?.worktreeNavStates) {
          // v4 briefly had `activeTab: "files"` and `selectedFilePath` on nav
          // states. Both are gone; rewrite "files" -> "terminal" and drop the
          // stale field so the type stays clean on rehydrate.
          for (const nav of Object.values(persistedState.worktreeNavStates) as any[]) {
            if (nav?.activeTab === "files") nav.activeTab = "terminal";
            if (nav && "selectedFilePath" in nav) delete nav.selectedFilePath;
          }
        }
        if (fromVersion < 6 && persistedState?.worktreeNavStates) {
          // `userTabs` became a required field on WorktreeNavState after v5
          // shipped without a migration. Old persisted states rehydrate with
          // userTabs === undefined and crash the first .find/.some/.map on it.
          for (const nav of Object.values(persistedState.worktreeNavStates) as any[]) {
            if (nav && !Array.isArray(nav.userTabs)) nav.userTabs = [];
          }
        }
        return persistedState;
      },
      partialize: (state) => {
        const {
          showResolved,
          generalTerminalActive,
          previousProject,
          previousWorktree,
          generalTerminalSplitTree,
          generalTerminalFocusedPaneId,
          linearApiKey,
          pendingTreeReveal,
          fileFinderOpen,
          commandPaletteOpen,
          panelDragActive,
          worktreeNavStates,
          worktreeBaseDirOverride,
          worktreeDefaultBaseDir,
          ...rest
        } = state;
        // Strip in-memory-only fields from each nav state.
        const cleanedNavStates: Record<string, WorktreeNavState> = {};
        for (const [path, nav] of Object.entries(worktreeNavStates)) {
          const { lastUsedActionId, ...persistableNav } = nav;
          cleanedNavStates[path] = persistableNav as WorktreeNavState;
        }
        return { ...rest, worktreeNavStates: cleanedNavStates };
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          initThemeFromStore(state.activeThemeId, state.customThemes, state.windowVibrancy ?? "off");
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
  projectActionsCache: Record<string, Action[]>;
  setProjectActionsCache: (projectPath: string, actions: Action[]) => void;
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
    projectActionsCache: {},
    setProjectActionsCache: (projectPath, actions) =>
      set((state) => {
        const prev = state.projectActionsCache[projectPath];
        if (
          prev &&
          prev.length === actions.length &&
          prev.every((a, i) => a === actions[i])
        ) {
          return state;
        }
        return {
          projectActionsCache: {
            ...state.projectActionsCache,
            [projectPath]: actions,
          },
        };
      }),
  })
);

/**
 * Worktrees as the user wants to see them.
 *
 * When `worktreeFilterEnabled` is on, hides any worktree whose path doesn't
 * sit under the configured base directory. Main worktrees (the repo root —
 * identified by `title === null`, set in lib.rs::list_worktrees) are always
 * kept so the user never loses access to the primary checkout.
 */
export function useFilteredWorktrees(): Worktree[] {
  const worktrees = useDataStore((s) => s.worktrees);
  const enabled = useUIStore((s) => s.worktreeFilterEnabled);
  const override = useUIStore((s) => s.worktreeBaseDirOverride);
  const defaultDir = useUIStore((s) => s.worktreeDefaultBaseDir);
  const baseDir = override ?? defaultDir;
  return useMemo(() => {
    if (!enabled || !baseDir) return worktrees;
    const prefix = baseDir.endsWith("/") ? baseDir : `${baseDir}/`;
    return worktrees.filter(
      (w) => w.title === null || w.path === baseDir || w.path.startsWith(prefix),
    );
  }, [worktrees, enabled, baseDir]);
}
