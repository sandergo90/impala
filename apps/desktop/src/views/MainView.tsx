import { useCallback, useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { Sidebar, CollapsedSidebar } from "../components/Sidebar";
import { RightSidebar } from "../components/RightSidebar";
import { DiffView } from "../components/DiffView";
import { PlanView } from "../components/PlanView";
import { SplitTreeRenderer } from "../components/SplitTreeRenderer";
import {
  ResizablePanelGroup,
  ResizablePanel as RrpResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ResizablePanel } from "../components/ResizablePanel";

const DEFAULT_SIDEBAR_WIDTH = 220;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 360;
const DEFAULT_RIGHT_SIDEBAR_WIDTH = 300;
const MIN_RIGHT_SIDEBAR_WIDTH = 220;
const MAX_RIGHT_SIDEBAR_WIDTH = 500;
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { OpenInEditorButton } from "../components/OpenInEditorButton";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { WorktreeTerminals } from "../components/WorktreeTerminals";
import { triggerRunScript, stopRunScript } from "../lib/run-script";
import { useAppHotkey } from "../hooks/useAppHotkey";
import { useHotkeyTooltip } from "../components/HotkeyDisplay";
import { TabPill } from "../components/TabPill";
import { activateGeneralTerminal } from "../hooks/useWorktreeActions";
import { usePlanNotifications } from "../hooks/usePlanNotifications";
import { createUserTab, stepActiveTab } from "../lib/tab-actions";

let cachedHomeDir: string | null = null;

export function MainView() {
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth) ?? DEFAULT_SIDEBAR_WIDTH;
  const rightSidebarWidth =
    useUIStore((s) => s.rightSidebarWidth) ?? DEFAULT_RIGHT_SIDEBAR_WIDTH;
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [isRightSidebarResizing, setIsRightSidebarResizing] = useState(false);

  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const selectedProject = useUIStore((s) => s.selectedProject);
  const wtPath = selectedWorktree?.path;

  // General terminal state
  const [homeDirPath, setHomeDirPath] = useState<string | null>(cachedHomeDir);
  useEffect(() => {
    if (cachedHomeDir) return;
    homeDir().then((dir) => { cachedHomeDir = dir; setHomeDirPath(dir); }).catch(() => { cachedHomeDir = "/tmp"; setHomeDirPath("/tmp"); });
  }, []);
  const generalTerminalActive = useUIStore((s) => s.generalTerminalActive);
  const generalTerminalSplitTree = useUIStore((s) => s.generalTerminalSplitTree);
  const generalTerminalFocusedPaneId = useUIStore((s) => s.generalTerminalFocusedPaneId);
  const generalTerminalPaneSessions = useDataStore((s) => s.generalTerminalPaneSessions);
  const navState = useUIStore((s) =>
    wtPath ? s.worktreeNavStates[wtPath] ?? null : null
  );
  const dataState = useDataStore((s) =>
    wtPath ? s.worktreeDataStates[wtPath] ?? null : null
  );

  const activeTab = navState?.activeTab ?? "diff";

  const runStatus = useUIStore((s) =>
    wtPath ? s.worktreeNavStates[wtPath]?.runStatus ?? "idle" : "idle",
  );
  const isRunning = runStatus === "running";
  const isStopping = runStatus === "stopping";
  const hasUnreadRunFailure = useUIStore((s) =>
    wtPath ? s.worktreeNavStates[wtPath]?.hasUnreadRunFailure ?? false : false,
  );

  usePlanNotifications();

  const sidebarTooltip = useHotkeyTooltip("TOGGLE_SIDEBAR", sidebarCollapsed ? "Show sidebar" : "Hide sidebar");
  const runScriptTooltip = useHotkeyTooltip("RUN_SCRIPT", isRunning ? "Stop script" : "Run script");
  const openInEditorTooltip = useHotkeyTooltip("OPEN_IN_EDITOR", "Open in editor");

  const setTab = (tab: "diff" | "terminal" | "split" | "plan") => {
    if (!selectedWorktree) return;
    useUIStore
      .getState()
      .updateWorktreeNavState(selectedWorktree.path, { activeTab: tab });
  };

  // -- Tab switching via Cmd+Shift+1/2/3/4 --
  useAppHotkey("SWITCH_TAB_TERMINAL", () => setTab("terminal"));
  useAppHotkey("SWITCH_TAB_DIFF", () => setTab("diff"));
  useAppHotkey("SWITCH_TAB_SPLIT", () => setTab("split"));
  useAppHotkey("SWITCH_TAB_PLAN", () => setTab("plan"));

  const isWorktreeTerminalActive = Boolean(wtPath) && activeTab === "terminal";

  useAppHotkey(
    "NEW_TERMINAL_TAB",
    () => {
      if (wtPath) createUserTab(wtPath, "terminal");
    },
    { enabled: isWorktreeTerminalActive },
    [wtPath, isWorktreeTerminalActive],
  );

  useAppHotkey(
    "NEW_CLAUDE_TAB",
    () => {
      if (wtPath) createUserTab(wtPath, "claude");
    },
    { enabled: isWorktreeTerminalActive },
    [wtPath, isWorktreeTerminalActive],
  );

  useAppHotkey(
    "NEXT_TAB",
    () => {
      if (!wtPath) return;
      stepActiveTab(wtPath, 1);
    },
    { enabled: isWorktreeTerminalActive },
    [wtPath, isWorktreeTerminalActive],
  );

  useAppHotkey(
    "PREV_TAB",
    () => {
      if (!wtPath) return;
      stepActiveTab(wtPath, -1);
    },
    { enabled: isWorktreeTerminalActive },
    [wtPath, isWorktreeTerminalActive],
  );

  // -- Layout hotkeys --

  useAppHotkey("TOGGLE_SIDEBAR", () => {
    setSidebarCollapsed((prev) => !prev);
  });

  useAppHotkey("TOGGLE_RIGHT_SIDEBAR", () => {
    setShowSidebar((prev) => !prev);
  });

  useAppHotkey("OPEN_IN_EDITOR", async () => {
    const wt = useUIStore.getState().selectedWorktree;
    if (!wt) return;
    const editor = useUIStore.getState().preferredEditor || "cursor";
    try {
      await invoke("open_in_editor", { editor, path: wt.path, line: null, col: null });
    } catch (e) {
      toast.error(String(e));
    }
  });

  useAppHotkey("TOGGLE_TERMINAL", () => {
    const state = useUIStore.getState();

    if (state.generalTerminalActive) {
      // Toggle back to previous worktree
      state.setGeneralTerminalActive(false);
      if (state.previousWorktree) {
        const worktrees = useDataStore.getState().worktrees;
        const stillExists = worktrees.some(
          (wt) => wt.path === state.previousWorktree?.path
        );
        if (stillExists) {
          state.setSelectedWorktree(state.previousWorktree);
        }
        state.setPreviousWorktree(null);
      }
    } else {
      activateGeneralTerminal();
    }
  });

  const handleGeneralTerminalFocusPane = useCallback((paneId: string) => {
    useUIStore.getState().setGeneralTerminalFocusedPaneId(paneId);
  }, []);

  const handleGeneralTerminalSessionSpawned = useCallback((paneId: string, sessionId: string) => {
    useDataStore.getState().updateGeneralTerminalPaneSession(paneId, sessionId);
  }, []);

  return (
    <>
      {/* Title bar */}
      <div
        className="relative flex items-center h-16 shrink-0 border-b border-border/50 bg-background"
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
          {selectedWorktree && (() => {
            const branch = selectedWorktree.branch;
            const isMain = branch === "main" || branch === "master" || branch === "develop";
            const aheadCount = dataState?.commits?.length ?? 0;
            const primary = isMain ? branch : (selectedWorktree.title ?? branch);
            const metaParts: string[] = [];
            if (selectedProject?.name) metaParts.push(selectedProject.name);
            if (!isMain) metaParts.push(branch);
            if (dataState?.baseBranch && aheadCount > 0) {
              metaParts.push(`${aheadCount} ahead of ${dataState.baseBranch}`);
            }
            return (
              <div className="flex flex-col justify-center min-w-0">
                <span
                  className={`truncate max-w-[420px] text-[15px] font-semibold text-foreground ${isMain ? "font-mono" : ""}`}
                  title={primary}
                >
                  {primary}
                </span>
                {metaParts.length > 0 && (
                  <span
                    className="truncate max-w-[420px] text-[11px] text-muted-foreground/80 font-mono"
                    title={metaParts.join(" · ")}
                  >
                    {metaParts.join(" · ")}
                  </span>
                )}
              </div>
            );
          })()}
        </div>

        {/* Center: run + tabs */}
        {selectedWorktree && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ paddingLeft: "88px" }}>
            <div className="relative flex items-center gap-1.5 pointer-events-auto">
              <button
                onClick={() => {
                  if (isRunning) stopRunScript();
                  else triggerRunScript();
                }}
                disabled={isStopping}
                className={`relative p-1.5 rounded disabled:opacity-30 disabled:cursor-not-allowed ${
                  isRunning || isStopping
                    ? "text-red-400 bg-red-500/15 hover:bg-red-500/25"
                    : "text-green-400 bg-green-500/15 hover:bg-green-500/25"
                }`}
                title={runScriptTooltip}
              >
                {isRunning || isStopping ? (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                    <rect x="2" y="2" width="12" height="12" rx="1" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 2l10 6-10 6V2z" />
                  </svg>
                )}
              </button>
              <span className="mx-0.5 w-px h-3.5 bg-border/50" />
              {([
                { tab: "terminal" as const, label: "Terminal", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg> },
                { tab: "diff" as const, label: "Diff", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18M3 12h18"/></svg> },
                { tab: "split" as const, label: "Split", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg> },
                { tab: "plan" as const, label: "Plan", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> },
              ]).map(({ tab, label, icon }) => (
                <button
                  key={tab}
                  onClick={() => setTab(tab)}
                  className={`relative flex items-center gap-1.5 px-3 py-1 text-md font-medium rounded-[5px] transition-colors ${
                    activeTab === tab
                      ? "text-foreground bg-accent"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {icon}
                  {label}
                  {tab === "terminal" && hasUnreadRunFailure && (
                    <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-red-500" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Right: open + sidebar */}
        <div className="relative flex items-center gap-1.5 pr-4 ml-auto shrink-0">
          {selectedWorktree && (
            <OpenInEditorButton worktreePath={selectedWorktree.path} tooltip={openInEditorTooltip} />
          )}
          <span className="mx-0.5 w-px h-3.5 bg-border/50" />
          <TabPill label="Sidebar" isActive={showSidebar} onClick={() => setShowSidebar(!showSidebar)} />
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
        <div className="flex flex-1 min-h-0 min-w-0">
          {sidebarCollapsed ? (
            <CollapsedSidebar onExpand={() => setSidebarCollapsed(false)} />
          ) : (
            <ResizablePanel
              width={sidebarWidth}
              onWidthChange={(w) => useUIStore.getState().setSidebarWidth(w)}
              isResizing={isSidebarResizing}
              onResizingChange={setIsSidebarResizing}
              minWidth={MIN_SIDEBAR_WIDTH}
              maxWidth={MAX_SIDEBAR_WIDTH}
              handleSide="right"
              onDoubleClickHandle={() =>
                useUIStore.getState().setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
              }
            >
              <Sidebar />
            </ResizablePanel>
          )}

          {/* Content */}
          <div className="flex flex-1 min-w-0 min-h-0">
            {!selectedWorktree ? (
              generalTerminalActive && homeDirPath ? (
                <SplitTreeRenderer
                  tree={generalTerminalSplitTree}
                  worktreePath={homeDirPath}
                  cwd={homeDirPath}
                  isGenericTerminal
                  focusedPaneId={generalTerminalFocusedPaneId}
                  paneSessions={generalTerminalPaneSessions}
                  onFocusPane={handleGeneralTerminalFocusPane}
                  onSessionSpawned={handleGeneralTerminalSessionSpawned}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                  Select a worktree
                </div>
              )
            ) : activeTab === "plan" ? (
              <div className="flex-1 min-w-0">
                <PlanView />
              </div>
            ) : activeTab === "split" ? (
              <ResizablePanelGroup orientation="horizontal">
                <RrpResizablePanel defaultSize="50%" minSize={200}>
                  <WorktreeTerminals activeWorktreePath={wtPath!} claudeOnly />
                </RrpResizablePanel>
                <ResizableHandle withHandle />
                <RrpResizablePanel defaultSize="50%" minSize={200}>
                  <DiffView />
                </RrpResizablePanel>
              </ResizablePanelGroup>
            ) : (
              <div className="relative flex-1 min-w-0">
                {/* Solid bg — xterm's WebGL canvas is on its own GPU layer
                    and doesn't reliably respect the parent's
                    `visibility: hidden` under WebKit, so without a backdrop
                    here it bleeds through the Diff view. */}
                <div
                  className={`absolute inset-0 bg-background ${activeTab === "diff" ? "z-10" : "z-0 invisible"}`}
                >
                  <DiffView />
                </div>
                <div className={`absolute inset-0 ${activeTab !== "diff" ? "z-10" : "z-0 invisible"}`}>
                  <WorktreeTerminals
                    activeWorktreePath={
                      activeTab === "terminal" ? wtPath! : null
                    }
                  />
                </div>
              </div>
            )}
          </div>

          {showSidebar && !generalTerminalActive && (
            <ResizablePanel
              width={rightSidebarWidth}
              onWidthChange={(w) => useUIStore.getState().setRightSidebarWidth(w)}
              isResizing={isRightSidebarResizing}
              onResizingChange={setIsRightSidebarResizing}
              minWidth={MIN_RIGHT_SIDEBAR_WIDTH}
              maxWidth={MAX_RIGHT_SIDEBAR_WIDTH}
              handleSide="left"
              onDoubleClickHandle={() =>
                useUIStore
                  .getState()
                  .setRightSidebarWidth(DEFAULT_RIGHT_SIDEBAR_WIDTH)
              }
            >
              <RightSidebar />
            </ResizablePanel>
          )}
        </div>
      </WorkerPoolContextProvider>
    </>
  );
}
