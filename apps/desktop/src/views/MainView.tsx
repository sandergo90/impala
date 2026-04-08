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
import { triggerRunScript } from "../lib/run-script";
import { useAppHotkey } from "../hooks/useAppHotkey";
import { HotkeyDisplay, useHotkeyTooltip } from "../components/HotkeyDisplay";

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

  const sidebarTooltip = useHotkeyTooltip("TOGGLE_SIDEBAR", sidebarCollapsed ? "Show sidebar" : "Hide sidebar");
  const runScriptTooltip = useHotkeyTooltip("RUN_SCRIPT", "Run script");

  const setTab = (tab: "diff" | "terminal" | "split") => {
    if (!selectedWorktree) return;
    useUIStore
      .getState()
      .updateWorktreeNavState(selectedWorktree.path, { activeTab: tab });
  };

  // -- Layout hotkeys --

  useAppHotkey("TOGGLE_SIDEBAR", () => {
    setSidebarCollapsed((prev) => !prev);
  });

  useAppHotkey("TOGGLE_RIGHT_SIDEBAR", () => {
    setShowSidebar((prev) => !prev);
  });

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
      className={`px-2.5 py-1 text-xs font-medium rounded-[5px] transition-colors ${
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
      {/* Title bar */}
      <div
        className="relative flex items-center h-12 shrink-0 border-b border-border/50 bg-background"
        style={{ paddingLeft: "88px" }}
      >
        <div className="absolute inset-0" data-tauri-drag-region />

        {/* Left: sidebar toggle + breadcrumb */}
        <div className="relative flex items-center gap-2 h-full">
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="relative text-muted-foreground hover:text-foreground p-1.5 rounded hover:bg-accent"
            title={sidebarTooltip}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
          {selectedWorktree && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground/60">{selectedProject?.name}</span>
              <span className="text-muted-foreground/30">/</span>
              <span className="text-foreground font-medium font-mono text-xs truncate max-w-[200px]">
                {selectedWorktree.branch}
              </span>
              {dataState?.baseBranch && (dataState?.commits?.length ?? 0) > 0 && (
                <span className="bg-accent rounded-full px-1.5 py-0.5 text-xs text-muted-foreground">
                  {dataState.commits.length} ahead of {dataState.baseBranch}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Center: search / command palette trigger (absolutely centered) */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <button
            onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true }))}
            className="pointer-events-auto flex items-center gap-2 h-7 px-3 rounded-md border border-border/60 bg-accent/50 hover:bg-accent text-muted-foreground text-xs transition-colors cursor-pointer min-w-[200px] max-w-[280px]"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/50">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.3-4.3"/>
            </svg>
            <span className="flex-1 text-left truncate">Search...</span>
            <HotkeyDisplay id="OPEN_COMMAND_PALETTE" className="text-muted-foreground/50" />
          </button>
        </div>

        {/* Right: open + run + tabs */}
        <div className="relative flex items-center gap-1.5 pr-4 ml-auto shrink-0">
          {selectedWorktree && (
            <>
              <OpenInEditorButton worktreePath={selectedWorktree.path} />
              <button
                onClick={() => triggerRunScript()}
                className="relative text-muted-foreground hover:text-foreground p-1.5 rounded hover:bg-accent"
                title={runScriptTooltip}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4 2l10 6-10 6V2z" />
                </svg>
              </button>
              <span className="mx-0.5 w-px h-3.5 bg-border/50" />
              {tabPill("Diff", activeTab === "diff", () => setTab("diff"))}
              {tabPill("Terminal", activeTab === "terminal", () => setTab("terminal"))}
              {tabPill("Split", activeTab === "split", () => setTab("split"))}
              <span className="mx-0.5 w-px h-3.5 bg-border/50" />
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
