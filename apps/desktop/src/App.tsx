import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { CommitPanel } from "./components/CommitPanel";
import { DiffView } from "./components/DiffView";
import { GhosttyTerminal } from "./components/GhosttyTerminal";
import { Toaster } from "./components/ui/sonner";
import { useAppStore } from "./store";

function App() {
  const [gitError, setGitError] = useState(false);
  const [checking, setChecking] = useState(true);
  const [showChanges, setShowChanges] = useState(true);

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
      {/* Unified top bar — blends with macOS titlebar */}
      <div
        className="flex items-center h-10 shrink-0 border-b border-border/50 bg-background"
        style={{ paddingLeft: "78px" }}
        data-tauri-drag-region
      >
        <div className="flex items-center gap-1 mr-auto">
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
            !selectedWorktree || showSplit
          )}
          {tabButton(
            "Split",
            showSplit,
            handleSplitToggle,
            !selectedWorktree
          )}
        </div>
        <div className="flex items-center gap-2 pr-3">
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
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <div className="w-48 min-w-40 shrink-0 border-r border-border/50">
          <Sidebar />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 relative">
          {showSplit ? (
            <div className="flex h-full">
              <div className="flex-1 min-w-0 border-r border-border/50">
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
              <div className="flex-1 min-w-0">
                <DiffView />
              </div>
            </div>
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
                  {selectedWorktree
                    ? "Starting terminal..."
                    : "Select a worktree to open a terminal"}
                </div>
              )}
            </>
          )}

          {/* Right drawer — Changes/Commits panel */}
          {showChanges && (
            <div className="absolute top-0 right-0 h-full w-72 border-l border-border/50 bg-background shadow-xl z-10 overflow-hidden">
              <CommitPanel />
            </div>
          )}
        </div>
      </div>

      <Toaster />
    </div>
  );
}

export default App;
