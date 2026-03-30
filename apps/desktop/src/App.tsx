import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar, CollapsedSidebar } from "./components/Sidebar";
import { RightSidebar } from "./components/RightSidebar";
import { DiffView } from "./components/DiffView";
import { SplitTreeRenderer } from "./components/SplitTreeRenderer";
import { SettingsView } from "./components/SettingsView";
import { CommandPalette } from "./components/CommandPalette";
import { Toaster } from "./components/ui/sonner";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { useUIStore, useDataStore } from "./store";
import { splitNode, removeNode, getAdjacentLeafId, getLeaves } from "./lib/split-tree";

/** Keeps all visited worktree terminals mounted (hidden when inactive) to avoid remounting */
function WorktreeTerminals({
  activeWorktreePath,
  onFocusPane,
  onSessionSpawned,
  claudeOnly = false,
}: {
  activeWorktreePath: string | null;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
  claudeOnly?: boolean;
}) {
  const [visitedPaths, setVisitedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (activeWorktreePath) {
      setVisitedPaths((prev) => {
        if (prev.has(activeWorktreePath)) return prev;
        return new Set([...prev, activeWorktreePath]);
      });
    }
  }, [activeWorktreePath]);

  return (
    <div className="relative h-full">
      {[...visitedPaths].map((path) => {
        const isActive = path === activeWorktreePath;
        return (
          <div
            key={path}
            className="absolute inset-0"
            style={{
              visibility: isActive ? "visible" : "hidden",
              zIndex: isActive ? 1 : 0,
              pointerEvents: isActive ? "auto" : "none",
            }}
          >
            <WorktreeTerminalPane
              worktreePath={path}
              isActive={isActive}
              onFocusPane={onFocusPane}
              onSessionSpawned={onSessionSpawned}
              claudeOnly={claudeOnly}
            />
          </div>
        );
      })}
    </div>
  );
}

function WorktreeTerminalPane({
  worktreePath,
  isActive,
  onFocusPane,
  onSessionSpawned,
  claudeOnly = false,
}: {
  worktreePath: string;
  isActive: boolean;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
  claudeOnly?: boolean;
}) {
  // Subscribe to raw stored state to trigger re-renders when nav state changes
  useUIStore((s) => s.worktreeNavStates[worktreePath]);
  const dataState = useDataStore((s) => s.worktreeDataStates[worktreePath]);
  // Compute merged nav state synchronously (getWorktreeNavState creates new objects, can't use in selector)
  const nav = useUIStore.getState().getWorktreeNavState(worktreePath);

  const tree = claudeOnly
    ? (getLeaves(nav.splitTree).find((l) => l.paneType === "claude") ?? nav.splitTree)
    : nav.splitTree;

  return (
    <SplitTreeRenderer
      tree={tree}
      worktreePath={worktreePath}
      focusedPaneId={isActive ? nav.focusedPaneId : ""}
      paneSessions={dataState?.paneSessions ?? {}}
      onFocusPane={onFocusPane}
      onSessionSpawned={onSessionSpawned}
    />
  );
}

function App() {
  const [gitError, setGitError] = useState(false);
  const [checking, setChecking] = useState(true);
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const currentView = useUIStore((s) => s.currentView);
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const selectedProject = useUIStore((s) => s.selectedProject);
  const wtPath = selectedWorktree?.path;
  const navState = useUIStore((s) =>
    wtPath ? (s.worktreeNavStates[wtPath] ?? null) : null
  );
  const dataState = useDataStore((s) =>
    wtPath ? (s.worktreeDataStates[wtPath] ?? null) : null
  );

  const activeTab = navState?.activeTab ?? "diff";

  useEffect(() => {
    invoke("check_git")
      .catch(() => setGitError(true))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ",") {
        e.preventDefault();
        const view = useUIStore.getState().currentView;
        useUIStore.getState().setCurrentView(view === "settings" ? "main" : "settings");
        return;
      }

      // Cmd+P → command palette
      if (e.metaKey && e.key === "p") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }

      // Split keybindings apply when terminal or split tab is active
      if (!wtPath) return;
      const nav = useUIStore.getState().getWorktreeNavState(wtPath);
      if (nav.activeTab !== "terminal" && nav.activeTab !== "split") return;

      const focusedId = nav.focusedPaneId;
      const tree = nav.splitTree;

      // Cmd+D → split vertical
      if (e.metaKey && !e.shiftKey && e.key === "d") {
        e.preventDefault();
        if (nav.activeTab === "split") return;
        const result = splitNode(tree, focusedId, "vertical");
        if (result) {
          useUIStore.getState().updateWorktreeNavState(wtPath, {
            splitTree: result.tree,
            focusedPaneId: result.newLeafId,
          });
        }
        return;
      }

      // Cmd+Shift+D → split horizontal
      if (e.metaKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        if (nav.activeTab === "split") return;
        const result = splitNode(tree, focusedId, "horizontal");
        if (result) {
          useUIStore.getState().updateWorktreeNavState(wtPath, {
            splitTree: result.tree,
            focusedPaneId: result.newLeafId,
          });
        }
        return;
      }

      // Cmd+] → next pane
      if (e.metaKey && e.key === "]") {
        e.preventDefault();
        const nextId = getAdjacentLeafId(tree, focusedId, 1);
        useUIStore.getState().updateWorktreeNavState(wtPath, { focusedPaneId: nextId });
        return;
      }

      // Cmd+[ → previous pane
      if (e.metaKey && e.key === "[") {
        e.preventDefault();
        const prevId = getAdjacentLeafId(tree, focusedId, -1);
        useUIStore.getState().updateWorktreeNavState(wtPath, { focusedPaneId: prevId });
        return;
      }

      // Cmd+W → close focused pane (don't close last)
      if (e.metaKey && e.key === "w") {
        e.preventDefault();
        const leaves = getLeaves(tree);
        if (leaves.length <= 1) return; // don't close last pane

        // Don't close Claude panes
        const focusedLeaf = leaves.find((l) => l.id === focusedId);
        if (focusedLeaf?.paneType === "claude") return;

        // Determine adjacent pane BEFORE removing, so we know the neighbor
        const adjacentId = getAdjacentLeafId(tree, focusedId, -1);

        const newTree = removeNode(tree, focusedId);
        if (!newTree) return;

        // Kill the PTY session for the closed pane
        const data = useDataStore.getState().getWorktreeDataState(wtPath);
        const sessionId = data.paneSessions[focusedId];
        if (sessionId) {
          invoke("pty_kill", { sessionId }).catch(() => {});
          const { [focusedId]: _, ...remaining } = data.paneSessions;
          useDataStore.getState().updateWorktreeDataState(wtPath, { paneSessions: remaining });
        }

        // Focus adjacent pane (fall back to first leaf if adjacent was the one removed)
        const newLeaves = getLeaves(newTree);
        const newLeafIds = new Set(newLeaves.map((l) => l.id));
        const newFocusId = newLeafIds.has(adjacentId) ? adjacentId : (newLeaves[0]?.id ?? "default");
        useUIStore.getState().updateWorktreeNavState(wtPath, {
          splitTree: newTree,
          focusedPaneId: newFocusId,
        });
        return;
      }
    };
    // Capture phase so split keybindings fire before the terminal consumes them
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [wtPath]);

  const handleTerminalTab = () => {
    if (!selectedWorktree) return;
    useUIStore.getState().updateWorktreeNavState(selectedWorktree.path, { activeTab: "terminal" });
  };

  const handleDiffTab = () => {
    if (!selectedWorktree) return;
    useUIStore
      .getState()
      .updateWorktreeNavState(selectedWorktree.path, { activeTab: "diff" });
  };

  const handleSplitTab = () => {
    if (!selectedWorktree) return;
    useUIStore
      .getState()
      .updateWorktreeNavState(selectedWorktree.path, { activeTab: "split" });
  };

  const handleFocusPane = useCallback((paneId: string) => {
    if (!wtPath) return;
    useUIStore.getState().updateWorktreeNavState(wtPath, { focusedPaneId: paneId });
  }, [wtPath]);

  const handleSessionSpawned = useCallback((paneId: string, sessionId: string) => {
    if (!wtPath) return;
    const current = useDataStore.getState().getWorktreeDataState(wtPath);
    useDataStore.getState().updateWorktreeDataState(wtPath, {
      paneSessions: { ...current.paneSessions, [paneId]: sessionId },
    });
  }, [wtPath]);

  if (checking) return null;

  if (gitError) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center">
          <h2 className="text-lg font-semibold mb-2">Git Not Found</h2>
          <p className="text-muted-foreground">
            Please install Git to use Differ.
          </p>
          <p className="text-muted-foreground text-xs mt-2">
            https://git-scm.com/download
          </p>
        </div>
      </div>
    );
  }

  const tabPill = (
    label: string,
    isActive: boolean,
    onClick: () => void,
    disabled?: boolean
  ) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1 text-[11px] font-medium rounded-[5px] transition-colors ${
        isActive
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
      style={isActive ? { background: "var(--accent)" } : undefined}
    >
      {label}
    </button>
  );

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col">
      {/* Title bar — branch context center, tab pills right */}
      <div
        className="relative flex items-center h-10 shrink-0 border-b border-border/50 bg-background"
        style={{ paddingLeft: "78px" }}
      >
        <div className="absolute inset-0" data-tauri-drag-region />
        {currentView === "main" ? (
          <>
            {/* Sidebar toggle */}
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="relative text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent"
              title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" fill="none" />
                <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>

            {/* Center context: project / branch · N ahead of base */}
            <div className="flex-1 flex items-center justify-center gap-1.5 text-[11px]" data-tauri-drag-region>
              {selectedWorktree && (
                <>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-muted-foreground/50 shrink-0">
                    <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
                    <circle cx="4" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
                    <line x1="4" y1="6" x2="4" y2="10" stroke="currentColor" strokeWidth="1.4"/>
                    <path d="M4 8 L10 4" stroke="currentColor" strokeWidth="1.4"/>
                    <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
                  </svg>
                  <span className="text-muted-foreground/60">{selectedProject?.name}</span>
                  <span className="text-muted-foreground/40">/</span>
                  <span className="text-foreground font-medium font-mono text-[12px]">{selectedWorktree.branch}</span>
                  {dataState?.baseBranch && (dataState?.commits?.length ?? 0) > 0 && (
                    <span className="bg-accent rounded-full px-1.5 py-0.5 text-[9px] text-muted-foreground">{dataState.commits.length} ahead of {dataState.baseBranch}</span>
                  )}
                </>
              )}
            </div>

            {/* Right: tabs + changes toggle */}
            <div className="relative flex items-center gap-1 pr-3">
              {selectedWorktree && (
                <>
                  {tabPill("Diff", activeTab === "diff", handleDiffTab)}
                  {tabPill("Terminal", activeTab === "terminal", handleTerminalTab)}
                  {tabPill("Split", activeTab === "split", handleSplitTab)}
                  <span className="mx-1 w-px h-3.5 bg-border" />
                </>
              )}
              {tabPill("Sidebar", showSidebar, () => setShowSidebar(!showSidebar))}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[11px] text-muted-foreground font-medium" data-tauri-drag-region>
            Settings
          </div>
        )}
      </div>

      {currentView === "settings" ? (
        <SettingsView />
      ) : (
        /* Main content area */
        <WorkerPoolContextProvider
          poolOptions={{
            workerFactory: () => new Worker(
              new URL("@pierre/diffs/worker/worker.js", import.meta.url),
              { type: "module" }
            ),
            poolSize: 2,
          }}
          highlighterOptions={{}}
        >
        <div className="flex flex-1 min-h-0">
        {sidebarCollapsed && (
          <CollapsedSidebar onExpand={() => setSidebarCollapsed(false)} />
        )}
        <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
          {/* Sidebar */}
          {!sidebarCollapsed && (
            <>
              <ResizablePanel defaultSize="15%" minSize={140} maxSize={300}>
                <Sidebar onOpenCommandPalette={() => setCommandPaletteOpen(true)} />
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}

          {/* Content */}
          <ResizablePanel defaultSize={showSidebar ? "65%" : "85%"}>
            <div className="flex flex-col h-full">
              {/* Tab content */}
              <div className="flex-1 min-h-0">
                {!selectedWorktree ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    Select a worktree
                  </div>
                ) : activeTab === "split" ? (
                  <ResizablePanelGroup orientation="horizontal">
                    <ResizablePanel defaultSize="50%" minSize={200}>
                      <WorktreeTerminals
                        activeWorktreePath={wtPath!}
                        onFocusPane={handleFocusPane}
                        onSessionSpawned={handleSessionSpawned}
                        claudeOnly
                      />
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize="50%" minSize={200}>
                      <DiffView />
                    </ResizablePanel>
                  </ResizablePanelGroup>
                ) : (
                  <>
                    <div className={activeTab === "diff" ? "h-full" : "hidden"}>
                      <DiffView />
                    </div>
                    <WorktreeTerminals
                      activeWorktreePath={activeTab === "terminal" ? wtPath! : null}
                      onFocusPane={handleFocusPane}
                      onSessionSpawned={handleSessionSpawned}
                    />
                  </>
                )}
              </div>
            </div>
          </ResizablePanel>

          {/* Right panel — Changes/Commits */}
          {showSidebar && (
            <>
              <ResizableHandle />
              <ResizablePanel defaultSize="20%" minSize={180} maxSize={400}>
                <RightSidebar />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
        </div>
        </WorkerPoolContextProvider>
      )}

      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      <Toaster />
    </div>
  );
}

export default App;
