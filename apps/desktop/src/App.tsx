import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { CommitPanel } from "./components/CommitPanel";
import { DiffView } from "./components/DiffView";
import { GhosttyTerminal } from "./components/GhosttyTerminal";
import { SettingsView } from "./components/SettingsView";
import { Toaster } from "./components/ui/sonner";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useUIStore, useDataStore } from "./store";

function App() {
  const [gitError, setGitError] = useState(false);
  const [checking, setChecking] = useState(true);
  const [showChanges, setShowChanges] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
  const ptySessionId = dataState?.ptySessionId ?? null;
  const showSplit = navState?.showSplit ?? false;

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
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleTerminalTab = async () => {
    if (!selectedWorktree) return;
    const worktreePath = selectedWorktree.path;
    useUIStore.getState().updateWorktreeNavState(worktreePath, { activeTab: "terminal" });
    const currentPty = useDataStore.getState().getWorktreeDataState(worktreePath).ptySessionId;
    if (!currentPty) {
      await invoke("pty_spawn", {
        sessionId: worktreePath,
        cwd: worktreePath,
      });
      useDataStore.getState().updateWorktreeDataState(worktreePath, { ptySessionId: worktreePath });
    }
  };

  const handleDiffTab = () => {
    if (!selectedWorktree) return;
    useUIStore
      .getState()
      .updateWorktreeNavState(selectedWorktree.path, { activeTab: "diff" });
  };

  const handleSplitToggle = async () => {
    if (!selectedWorktree) return;
    const worktreePath = selectedWorktree.path;
    const newSplit = !useUIStore.getState().getWorktreeNavState(worktreePath).showSplit;
    useUIStore.getState().updateWorktreeNavState(worktreePath, { showSplit: newSplit });
    if (newSplit) {
      const currentPty = useDataStore.getState().getWorktreeDataState(worktreePath).ptySessionId;
      if (!currentPty) {
        await invoke("pty_spawn", {
          sessionId: worktreePath,
          cwd: worktreePath,
        });
        useDataStore.getState().updateWorktreeDataState(worktreePath, { ptySessionId: worktreePath });
      }
    }
  };

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
                  <span className="text-muted-foreground/60">{selectedProject?.name}</span>
                  <span className="text-muted-foreground/40">/</span>
                  <span className="text-foreground font-medium font-mono">{selectedWorktree.branch}</span>
                  {dataState?.baseBranch && (dataState?.commits?.length ?? 0) > 0 && (
                    <>
                      <span className="text-muted-foreground/40">&middot;</span>
                      <span className="text-muted-foreground/60">{dataState.commits.length} ahead of {dataState.baseBranch}</span>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Right: tabs + changes toggle */}
            <div className="relative flex items-center gap-1 pr-3">
              {selectedWorktree && (
                <>
                  {tabPill("Diff", !showSplit && activeTab === "diff", handleDiffTab, showSplit)}
                  {tabPill("Terminal", !showSplit && activeTab === "terminal", handleTerminalTab, showSplit)}
                  {tabPill("Split", showSplit, handleSplitToggle)}
                  <span className="mx-1 w-px h-3.5 bg-border" />
                </>
              )}
              {tabPill("Changes", showChanges, () => setShowChanges(!showChanges))}
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
        <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
          {/* Sidebar */}
          {!sidebarCollapsed && (
            <>
              <ResizablePanel defaultSize="15%" minSize={140} maxSize={300}>
                <Sidebar />
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}

          {/* Content */}
          <ResizablePanel defaultSize={showChanges ? "65%" : "85%"}>
            <div className="flex flex-col h-full">
              {/* Tab content */}
              <div className="flex-1 min-h-0">
                {!selectedWorktree ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    Select a worktree
                  </div>
                ) : showSplit ? (
                  <ResizablePanelGroup orientation="horizontal">
                    <ResizablePanel defaultSize="50%" minSize={200}>
                      {ptySessionId ? (
                        <GhosttyTerminal
                          key={ptySessionId}
                          sessionId={ptySessionId}
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                          Starting terminal...
                        </div>
                      )}
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
                    <div className={activeTab === "terminal" ? "h-full" : "hidden"}>
                      {ptySessionId ? (
                        <GhosttyTerminal
                          key={ptySessionId}
                          sessionId={ptySessionId}
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                          Starting terminal...
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </ResizablePanel>

          {/* Right panel — Changes/Commits */}
          {showChanges && (
            <>
              <ResizableHandle />
              <ResizablePanel defaultSize="20%" minSize={180} maxSize={400}>
                <CommitPanel />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      )}

      <Toaster />
    </div>
  );
}

export default App;
