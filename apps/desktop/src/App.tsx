import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { CommitPanel } from "./components/CommitPanel";
import { DiffView } from "./components/DiffView";
import { GhosttyTerminal } from "./components/GhosttyTerminal";
import { Toaster } from "./components/ui/sonner";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useAppStore } from "./store";

function App() {
  const [gitError, setGitError] = useState(false);
  const [checking, setChecking] = useState(true);
  const [showChanges, setShowChanges] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const selectedWorktree = useAppStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path;
  const wtState = useAppStore((s) =>
    wtPath ? (s.worktreeStates[wtPath] ?? null) : null
  );

  const activeTab = wtState?.activeTab ?? "diff";
  const ptySessionId = wtState?.ptySessionId ?? null;
  const showSplit = wtState?.showSplit ?? false;

  useEffect(() => {
    invoke("check_git")
      .catch(() => setGitError(true))
      .finally(() => setChecking(false));
  }, []);

  const handleTerminalTab = async () => {
    if (!selectedWorktree) return;
    const worktreePath = selectedWorktree.path;
    const { updateWorktreeState, getWorktreeState } = useAppStore.getState();
    updateWorktreeState(worktreePath, { activeTab: "terminal" });
    const currentPty = getWorktreeState(worktreePath).ptySessionId;
    if (!currentPty) {
      await invoke("pty_spawn", {
        sessionId: worktreePath,
        cwd: worktreePath,
      });
      updateWorktreeState(worktreePath, { ptySessionId: worktreePath });
    }
  };

  const handleDiffTab = () => {
    if (!selectedWorktree) return;
    useAppStore
      .getState()
      .updateWorktreeState(selectedWorktree.path, { activeTab: "diff" });
  };

  const handleSplitToggle = async () => {
    if (!selectedWorktree) return;
    const worktreePath = selectedWorktree.path;
    const { updateWorktreeState, getWorktreeState } = useAppStore.getState();
    const newSplit = !getWorktreeState(worktreePath).showSplit;
    updateWorktreeState(worktreePath, { showSplit: newSplit });
    if (newSplit) {
      const currentPty = getWorktreeState(worktreePath).ptySessionId;
      if (!currentPty) {
        await invoke("pty_spawn", {
          sessionId: worktreePath,
          cwd: worktreePath,
        });
        updateWorktreeState(worktreePath, { ptySessionId: worktreePath });
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

  const tabButton = (
    label: string,
    isActive: boolean,
    onClick: () => void,
    disabled?: boolean
  ) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1 text-[11px] font-medium rounded transition-colors ${
        isActive
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:text-foreground"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col">
      {/* Title bar — minimal, with sidebar toggle and Changes */}
      <div
        className="relative flex items-center h-10 shrink-0 border-b border-border/50 bg-background"
        style={{ paddingLeft: "78px" }}
      >
        <div className="absolute inset-0" data-tauri-drag-region />
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="relative text-muted-foreground hover:text-foreground px-2 py-1 text-sm"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
            <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
        <div className="flex-1" />
        <div className="relative flex items-center gap-2 pr-3">
          <button
            onClick={() => setShowChanges(!showChanges)}
            className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
              showChanges
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Changes
          </button>
        </div>
      </div>

      {/* Main content area */}
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
            {/* Tab bar — only shown when a worktree is selected */}
            {selectedWorktree && (
              <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 shrink-0">
                {tabButton(
                  "Diff",
                  !showSplit && activeTab === "diff",
                  handleDiffTab,
                  showSplit
                )}
                {tabButton(
                  "Terminal",
                  !showSplit && activeTab === "terminal",
                  handleTerminalTab,
                  showSplit
                )}
                {tabButton(
                  "Split",
                  showSplit,
                  handleSplitToggle
                )}
              </div>
            )}

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
                  {activeTab === "diff" && <DiffView />}
                  {activeTab === "terminal" && ptySessionId && (
                    <GhosttyTerminal
                      key={ptySessionId}
                      sessionId={ptySessionId}
                    />
                  )}
                  {activeTab === "terminal" && !ptySessionId && (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                      Starting terminal...
                    </div>
                  )}
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

      <Toaster />
    </div>
  );
}

export default App;
