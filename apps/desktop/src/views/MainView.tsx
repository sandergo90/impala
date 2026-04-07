import { useCallback, useState } from "react";
import { Sidebar, CollapsedSidebar } from "../components/Sidebar";
import { RightSidebar } from "../components/RightSidebar";
import { DiffView } from "../components/DiffView";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { OpenInEditorButton } from "../components/OpenInEditorButton";
import { useUIStore, useDataStore } from "../store";
import { WorktreeTerminals } from "../components/WorktreeTerminals";

export function MainView() {
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const selectedProject = useUIStore((s) => s.selectedProject);
  const wtPath = selectedWorktree?.path;
  const navState = useUIStore((s) =>
    wtPath ? s.worktreeNavStates[wtPath] ?? null : null
  );
  const dataState = useDataStore((s) =>
    wtPath ? s.worktreeDataStates[wtPath] ?? null : null
  );

  const activeTab = navState?.activeTab ?? "diff";

  const handleTerminalTab = () => {
    if (!selectedWorktree) return;
    useUIStore
      .getState()
      .updateWorktreeNavState(selectedWorktree.path, { activeTab: "terminal" });
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

  const handleFocusPane = useCallback(
    (paneId: string) => {
      if (!wtPath) return;
      useUIStore
        .getState()
        .updateWorktreeNavState(wtPath, { focusedPaneId: paneId });
    },
    [wtPath]
  );

  const handleSessionSpawned = useCallback(
    (paneId: string, sessionId: string) => {
      if (!wtPath) return;
      const current = useDataStore.getState().getWorktreeDataState(wtPath);
      useDataStore.getState().updateWorktreeDataState(wtPath, {
        paneSessions: { ...current.paneSessions, [paneId]: sessionId },
      });
    },
    [wtPath]
  );

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
    <>
      {/* Title bar — branch context center, tab pills right */}
      <div
        className="relative flex items-center h-10 shrink-0 border-b border-border/50 bg-background"
        style={{ paddingLeft: "78px" }}
      >
        <div className="absolute inset-0" data-tauri-drag-region />

        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="relative text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <rect
              x="1"
              y="2"
              width="14"
              height="12"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
            />
            <line
              x1="5.5"
              y1="2"
              x2="5.5"
              y2="14"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
        </button>

        {/* Center context: project / branch . N ahead of base */}
        <div
          className="flex-1 flex items-center justify-center gap-1.5 text-[11px]"
          data-tauri-drag-region
        >
          {selectedWorktree && (
            <>
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="text-muted-foreground/50 shrink-0"
              >
                <circle
                  cx="4"
                  cy="4"
                  r="2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                />
                <circle
                  cx="4"
                  cy="12"
                  r="2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                />
                <line
                  x1="4"
                  y1="6"
                  x2="4"
                  y2="10"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M4 8 L10 4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <circle
                  cx="12"
                  cy="4"
                  r="2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                />
              </svg>
              <span className="text-muted-foreground/60">
                {selectedProject?.name}
              </span>
              <span className="text-muted-foreground/40">/</span>
              <span className="text-foreground font-medium font-mono text-[12px]">
                {selectedWorktree.branch}
              </span>
              {dataState?.baseBranch &&
                (dataState?.commits?.length ?? 0) > 0 && (
                  <span className="bg-accent rounded-full px-1.5 py-0.5 text-[9px] text-muted-foreground">
                    {dataState.commits.length} ahead of{" "}
                    {dataState.baseBranch}
                  </span>
                )}
              <span className="mx-1 w-px h-3.5 bg-border/50" />
              <OpenInEditorButton worktreePath={selectedWorktree.path} />
            </>
          )}
        </div>

        {/* Right: tabs + changes toggle */}
        <div className="relative flex items-center gap-1 pr-3">
          {selectedWorktree && (
            <>
              {tabPill("Diff", activeTab === "diff", handleDiffTab)}
              {tabPill(
                "Terminal",
                activeTab === "terminal",
                handleTerminalTab
              )}
              {tabPill("Split", activeTab === "split", handleSplitTab)}
              <span className="mx-1 w-px h-3.5 bg-border" />
            </>
          )}
          {tabPill("Sidebar", showSidebar, () =>
            setShowSidebar(!showSidebar)
          )}
        </div>
      </div>

      {/* Main content area */}
      <WorkerPoolContextProvider
        poolOptions={{
          workerFactory: () =>
            new Worker(
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
          <ResizablePanelGroup
            orientation="horizontal"
            className="flex-1 min-h-0"
          >
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
                    <div className="relative h-full">
                      <div
                        className={`absolute inset-0 ${activeTab === "diff" ? "z-10" : "z-0 invisible"}`}
                      >
                        <DiffView />
                      </div>
                      <div className={`absolute inset-0 ${activeTab !== "diff" ? "z-10" : "z-0 invisible"}`}>
                        <WorktreeTerminals
                          activeWorktreePath={
                            activeTab === "terminal" ? wtPath! : null
                          }
                          onFocusPane={handleFocusPane}
                          onSessionSpawned={handleSessionSpawned}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>

            {/* Right panel -- Changes/Commits */}
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
    </>
  );
}
