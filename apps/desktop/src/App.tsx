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

  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const ptySessionId = useAppStore((s) => s.ptySessionId);
  const setPtySessionId = useAppStore((s) => s.setPtySessionId);
  const selectedWorktree = useAppStore((s) => s.selectedWorktree);

  useEffect(() => {
    invoke("check_git")
      .catch(() => setGitError(true))
      .finally(() => setChecking(false));
  }, []);

  const handleTerminalTab = async () => {
    setActiveTab("terminal");
    if (!ptySessionId && selectedWorktree) {
      const id = await invoke<string>("pty_spawn", {
        worktreePath: selectedWorktree.path,
      });
      setPtySessionId(id);
    }
  };

  const handleDiffTab = () => {
    setActiveTab("diff");
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
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === "diff"
                    ? "text-foreground border-b-2 border-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Diff
              </button>
              <button
                onClick={handleTerminalTab}
                disabled={!selectedWorktree}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === "terminal"
                    ? "text-foreground border-b-2 border-foreground"
                    : "text-muted-foreground hover:text-foreground"
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                Terminal
              </button>
            </div>

            {/* Tab content */}
            <div className="flex-1 min-h-0">
              {activeTab === "diff" && (
                <ResizablePanelGroup orientation="horizontal">
                  <ResizablePanel defaultSize="30%" minSize={200} maxSize={400}>
                    <CommitPanel />
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize="70%">
                    <DiffView />
                  </ResizablePanel>
                </ResizablePanelGroup>
              )}
              {activeTab === "terminal" && ptySessionId && (
                <GhosttyTerminal sessionId={ptySessionId} />
              )}
              {activeTab === "terminal" && !ptySessionId && (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  {selectedWorktree
                    ? "Starting terminal..."
                    : "Select a worktree to open a terminal"}
                </div>
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
