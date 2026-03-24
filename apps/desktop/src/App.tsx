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

  const selectedWorktree = useAppStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path;
  const wtState = useAppStore((s) =>
    wtPath ? (s.worktreeStates[wtPath] ?? null) : null
  );

  const activeTab = wtState?.activeTab ?? 'diff';
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
    useAppStore.getState().updateWorktreeState(selectedWorktree.path, { activeTab: "diff" });
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
        await invoke("pty_spawn", { sessionId: worktreePath, cwd: worktreePath });
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

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <ResizablePanelGroup
        orientation="horizontal"
        style={{ height: "100vh" }}
      >
        <ResizablePanel defaultSize="20%" minSize={180} maxSize={350}>
          <Sidebar />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="80%">
          <div className="flex flex-col h-full">
            {/* Tab bar */}
            <div className="flex items-center border-b border-border bg-muted/30 px-2 shrink-0">
              <button
                onClick={handleDiffTab}
                disabled={showSplit}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  !showSplit && activeTab === "diff"
                    ? "text-foreground border-b-2 border-foreground"
                    : "text-muted-foreground hover:text-foreground"
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                Diff
              </button>
              <button
                onClick={handleTerminalTab}
                disabled={!selectedWorktree || showSplit}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  !showSplit && activeTab === "terminal"
                    ? "text-foreground border-b-2 border-foreground"
                    : "text-muted-foreground hover:text-foreground"
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                Terminal
              </button>
              <button
                onClick={handleSplitToggle}
                disabled={!selectedWorktree}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  showSplit
                    ? "border-b-2 border-primary text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground"
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                Split
              </button>
            </div>

            {/* Tab content */}
            <div className="flex-1 min-h-0">
              {showSplit ? (
                <ResizablePanelGroup orientation="horizontal">
                  <ResizablePanel defaultSize="50%" minSize={200}>
                    {ptySessionId ? (
                      <GhosttyTerminal key={ptySessionId} sessionId={ptySessionId} />
                    ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                        Starting terminal...
                      </div>
                    )}
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize="50%" minSize={200}>
                    <ResizablePanelGroup orientation="horizontal">
                      <ResizablePanel defaultSize="35%" minSize={150}>
                        <CommitPanel />
                      </ResizablePanel>
                      <ResizableHandle />
                      <ResizablePanel defaultSize="65%">
                        <DiffView />
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                <>
                  {activeTab === "diff" && (
                    <ResizablePanelGroup orientation="horizontal">
                      <ResizablePanel defaultSize="25%" minSize={150} maxSize={400}>
                        <CommitPanel />
                      </ResizablePanel>
                      <ResizableHandle withHandle />
                      <ResizablePanel defaultSize="75%">
                        <DiffView />
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  )}
                  {activeTab === "terminal" && ptySessionId && (
                    <GhosttyTerminal key={ptySessionId} sessionId={ptySessionId} />
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
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <Toaster />
    </div>
  );
}

export default App;
