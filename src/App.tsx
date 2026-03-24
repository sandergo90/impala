import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { CommitPanel } from "./components/CommitPanel";
import { DiffView } from "./components/DiffView";
import { Toaster } from "./components/ui/sonner";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

function App() {
  const [gitError, setGitError] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    invoke("check_git")
      .catch(() => setGitError(true))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return null;

  if (gitError) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center">
          <h2 className="text-lg font-semibold mb-2">Git Not Found</h2>
          <p className="text-muted-foreground">Please install Git to use Differ.</p>
          <p className="text-muted-foreground text-xs mt-2">https://git-scm.com/download</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <ResizablePanelGroup orientation="horizontal" style={{ height: "100vh" }}>
        <ResizablePanel defaultSize="20%" minSize={180} maxSize={350}>
          <Sidebar />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="22%" minSize={200} maxSize={400}>
          <CommitPanel />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="58%">
          <DiffView />
        </ResizablePanel>
      </ResizablePanelGroup>
      <Toaster />
    </div>
  );
}

export default App;
