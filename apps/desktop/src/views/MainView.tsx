import { useCallback, useEffect, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { Sidebar, CollapsedSidebar } from "../components/Sidebar";
import { RightSidebar, type RightSidebarTab } from "../components/RightSidebar";
import { DiffView } from "../components/DiffView";
import { SplitTreeRenderer } from "../components/SplitTreeRenderer";
import { GeneralTerminalLeaf } from "../components/GeneralTerminalLeaf";
import { updateRatio } from "../lib/split-tree";
import { ResizablePanel } from "../components/ResizablePanel";

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 180;
const DEFAULT_RIGHT_SIDEBAR_WIDTH = 300;
const MIN_RIGHT_SIDEBAR_WIDTH = 220;
// Matches CollapsedSidebar's w-10; rem so it tracks the UI font-size setting.
const COLLAPSED_SIDEBAR_WIDTH = "2.5rem";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { OpenInEditorButton } from "../components/OpenInEditorButton";
import { invoke } from "@/lib/invoke";
import { cn } from "../lib/utils";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { WorktreeTerminals } from "../components/WorktreeTerminals";
import { useAppHotkey } from "../hooks/useAppHotkey";
import { useHotkeyTooltip } from "../components/HotkeyDisplay";
import { RunActionsButton } from "../components/RunActionsButton";
import { CommitPanel } from "../components/CommitPanel";
import { FileDiff, SquareTerminal } from "lucide-react";
import { TabPill } from "../components/TabPill";
import { activateGeneralTerminal } from "../hooks/useWorktreeActions";
import {
  addTabToActivePane,
  createUserTab,
  createBrowserTab,
  focusAdjacentActiveGroupTab,
  shouldCreateTabInFocusedPane,
  stepActiveTab,
} from "../lib/tab-actions";
import { shouldOpenChangesNavigator } from "../lib/change-navigation";
import { Popover } from "@base-ui/react/popover";

let cachedHomeDir: string | null = null;

export function MainView() {
  const showSidebar = useUIStore((s) => s.rightSidebarOpen);
  const setShowSidebar = useUIStore((s) => s.setRightSidebarOpen);
  const [rightSidebarTab, setRightSidebarTab] = useState<RightSidebarTab>("changes");
  const [changesPopoverOpen, setChangesPopoverOpen] = useState(false);
  const changesButtonRef = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth) ?? DEFAULT_SIDEBAR_WIDTH;
  const rightSidebarWidth =
    useUIStore((s) => s.rightSidebarWidth) ?? DEFAULT_RIGHT_SIDEBAR_WIDTH;
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [isRightSidebarResizing, setIsRightSidebarResizing] = useState(false);
  // Open/close animation state, derived at render time from the previous
  // toggle value and cleared by the container's own width transitionend.
  // While true the container clips its fixed-width content; the right
  // sidebar also stays mounted so it can slide out before unmounting.
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const [prevSidebarCollapsed, setPrevSidebarCollapsed] = useState(sidebarCollapsed);
  if (sidebarCollapsed !== prevSidebarCollapsed) {
    setPrevSidebarCollapsed(sidebarCollapsed);
    setSidebarAnimating(true);
  }
  const [rightSidebarAnimating, setRightSidebarAnimating] = useState(false);
  const [prevShowSidebar, setPrevShowSidebar] = useState(showSidebar);
  if (showSidebar !== prevShowSidebar) {
    setPrevShowSidebar(showSidebar);
    setRightSidebarAnimating(true);
  }
  // Mirror sidebar drags into the store so the native browser webview can
  // hide during the drag (it would otherwise capture the cursor mid-drag).
  const handleSidebarResizing = useCallback((resizing: boolean) => {
    setIsSidebarResizing(resizing);
    useUIStore.getState().setPanelDragActive(resizing);
  }, []);
  const handleRightSidebarResizing = useCallback((resizing: boolean) => {
    setIsRightSidebarResizing(resizing);
    useUIStore.getState().setPanelDragActive(resizing);
  }, []);
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
  const changesButtonActive = !showSidebar && (activeTab === "diff" || changesPopoverOpen);

  const hasUnreadRunFailure = useUIStore((s) =>
    wtPath ? s.worktreeNavStates[wtPath]?.hasUnreadRunFailure ?? false : false,
  );

  const sidebarTooltip = useHotkeyTooltip("TOGGLE_SIDEBAR", sidebarCollapsed ? "Show sidebar" : "Hide sidebar");
  const openInEditorTooltip = useHotkeyTooltip("OPEN_IN_EDITOR", "Open in editor");

  const openWorkspace = () => {
    if (!selectedWorktree) return;
    useUIStore
      .getState()
      .updateWorktreeNavState(selectedWorktree.path, { activeTab: "terminal" });
  };

  const closeChanges = useCallback(() => {
    setChangesPopoverOpen(false);
  }, []);

  const toggleChanges = () => {
    if (changesPopoverOpen) {
      closeChanges();
      return;
    }
    if (!selectedWorktree) return;
    const currentNav = useUIStore.getState().getWorktreeNavState(selectedWorktree.path);
    useUIStore.getState().updateWorktreeNavState(selectedWorktree.path, { activeTab: "diff" });
    setRightSidebarTab("changes");
    setShowSidebar(false);
    setChangesPopoverOpen(
      shouldOpenChangesNavigator(currentNav.activeTab, currentNav.viewMode),
    );
  };

  const revealInFiles = useCallback(() => {
    setChangesPopoverOpen(false);
    setRightSidebarTab("files");
    setShowSidebar(true);
  }, []);

  const toggleRightSidebar = useCallback(() => {
    setChangesPopoverOpen(false);
    const s = useUIStore.getState();
    s.setRightSidebarOpen(!s.rightSidebarOpen);
  }, []);

  useAppHotkey("SWITCH_TAB_TERMINAL", openWorkspace);
  useAppHotkey("SWITCH_TAB_DIFF", toggleChanges);

  useEffect(() => {
    if (activeTab !== "diff" || !wtPath) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      // Let transient UI dismiss itself first. These surfaces are portalled,
      // so they are not necessarily descendants of the Diff view.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) {
        return;
      }

      event.preventDefault();
      useUIStore
        .getState()
        .updateWorktreeNavState(wtPath, { activeTab: "terminal" });
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeTab, wtPath]);

  const isWorktreeTerminalActive = Boolean(wtPath) && activeTab === "terminal";

  useAppHotkey(
    "NEW_TERMINAL_TAB",
    () => {
      if (!wtPath) return;
      if (shouldCreateTabInFocusedPane(wtPath)) {
        addTabToActivePane(wtPath, { kind: "terminal", launch: "shell" });
      } else {
        createUserTab(wtPath, "shell");
      }
    },
    { enabled: isWorktreeTerminalActive },
    [wtPath, isWorktreeTerminalActive],
  );

  useAppHotkey(
    "NEW_BROWSER_TAB",
    () => {
      if (!wtPath) return;
      if (shouldCreateTabInFocusedPane(wtPath)) {
        addTabToActivePane(wtPath, { kind: "browser" });
      } else {
        createBrowserTab(wtPath);
      }
    },
    { enabled: isWorktreeTerminalActive },
    [wtPath, isWorktreeTerminalActive],
  );

  useAppHotkey(
    "NEXT_TAB",
    () => {
      if (!wtPath) return;
      if (!focusAdjacentActiveGroupTab(wtPath, 1)) stepActiveTab(wtPath, 1);
    },
    { enabled: isWorktreeTerminalActive },
    [wtPath, isWorktreeTerminalActive],
  );

  useAppHotkey(
    "PREV_TAB",
    () => {
      if (!wtPath) return;
      if (!focusAdjacentActiveGroupTab(wtPath, -1)) stepActiveTab(wtPath, -1);
    },
    { enabled: isWorktreeTerminalActive },
    [wtPath, isWorktreeTerminalActive],
  );

  // -- Layout hotkeys --

  useAppHotkey("TOGGLE_SIDEBAR", () => {
    setSidebarCollapsed((prev) => !prev);
  });

  useAppHotkey("TOGGLE_RIGHT_SIDEBAR", () => {
    toggleRightSidebar();
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
      {/* Title bar. Three-column grid so the centered cluster can never overlap
          the breadcrumb: `minmax(0,1fr)` outer tracks let `truncate` engage. */}
      <div
        className="relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center h-16 shrink-0 border-b border-border/50 bg-background"
        style={{ paddingLeft: "88px" }}
      >
        <div className="absolute inset-0" data-tauri-drag-region />

        {/* Left: sidebar toggle + breadcrumb */}
        <div className="relative flex items-center gap-2 h-full min-w-0">
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
            const isPrimary = selectedWorktree.is_primary;
            const isMainline = branch === "main" || branch === "master" || branch === "develop";
            const aheadCount = dataState?.commits?.length ?? 0;
            const primary = isPrimary ? branch : (selectedWorktree.title ?? branch);
            const metaParts: string[] = [];
            if (selectedProject?.name) metaParts.push(selectedProject.name);
            if (!isPrimary) metaParts.push(branch);
            if (!isMainline && dataState?.baseBranch && aheadCount > 0) {
              metaParts.push(`${aheadCount} ahead of ${dataState.baseBranch}`);
            }
            return (
              <div className="flex flex-col justify-center min-w-0">
                <span
                  className={`truncate max-w-[420px] text-base font-semibold text-foreground ${isPrimary ? "font-mono" : ""}`}
                  title={primary}
                >
                  {primary}
                </span>
                {metaParts.length > 0 && (
                  <span
                    className="truncate max-w-[420px] text-sm text-muted-foreground font-mono"
                    title={metaParts.join(" · ")}
                  >
                    {metaParts.join(" · ")}
                  </span>
                )}
              </div>
            );
          })()}
        </div>

        {/* Center: run + tabs. The cell is always rendered so the right cluster
            can never auto-place into this column when no worktree is selected. */}
        <div
          className="relative flex items-center justify-center gap-1.5"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {selectedWorktree && (
            <>
              <RunActionsButton
                projectPath={selectedProject?.path ?? null}
                worktreePath={selectedWorktree?.path ?? null}
              />
              <span className="mx-0.5 h-5 w-px bg-border/60" />
              <button
                type="button"
                onClick={openWorkspace}
                className={`relative flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold outline-none transition-colors ${
                  activeTab === "terminal"
                    ? "bg-accent text-foreground"
                    : "text-foreground/70 hover:bg-accent/60 hover:text-foreground"
                }`}
                aria-pressed={activeTab === "terminal"}
              >
                <SquareTerminal aria-hidden="true" className="size-4" />
                Workspace
                {hasUnreadRunFailure && (
                  <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-danger" aria-label="Run failed" />
                )}
              </button>
              <Popover.Root
                open={changesPopoverOpen}
                onOpenChange={(open) => {
                  if (!open) closeChanges();
                }}
              >
                <button
                  ref={changesButtonRef}
                  type="button"
                  onClick={toggleChanges}
                  className={`relative z-30 flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold outline-none transition-colors ${
                    changesButtonActive
                      ? "bg-accent text-foreground"
                      : "text-foreground/70 hover:bg-accent/60 hover:text-foreground"
                  }`}
                  aria-haspopup="dialog"
                  aria-expanded={changesPopoverOpen}
                  aria-controls={changesPopoverOpen ? "changes-popover" : undefined}
                  aria-pressed={changesButtonActive}
                >
                  <FileDiff aria-hidden="true" className="size-4" />
                  Changes
                </button>
                <Popover.Portal>
                  <Popover.Positioner
                    anchor={changesButtonRef}
                    side="bottom"
                    sideOffset={8}
                    align="center"
                    positionMethod="fixed"
                    className="z-50"
                  >
                    <Popover.Popup
                      id="changes-popover"
                      finalFocus={changesButtonRef}
                      className="flex h-[min(640px,calc(100vh-5rem))] w-[min(380px,calc(100vw-1rem))] flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
                    >
                      <Popover.Title className="sr-only">Changes navigator</Popover.Title>
                      <CommitPanel
                        variant="popover"
                        onSelection={closeChanges}
                        onRevealInFiles={revealInFiles}
                      />
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            </>
          )}
        </div>

        {/* Right: open + sidebar */}
        <div className="relative flex items-center gap-1.5 pr-4 justify-self-end shrink-0">
          {selectedWorktree && (
            <OpenInEditorButton worktreePath={selectedWorktree.path} tooltip={openInEditorTooltip} />
          )}
          <span className="mx-0.5 w-px h-3.5 bg-border/50" />
          <TabPill label="Sidebar" isActive={showSidebar} onClick={toggleRightSidebar} />
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
          {/* The container animates width while the rail and the full sidebar
              cross-fade as fixed-width layers, so neither squishes mid-flight.
              Overflow clips only during the animation: at rest the resize
              handle needs its 8px bleed outside the panel edge. */}
          <div
            className={cn(
              "relative h-full shrink-0 bg-sidebar",
              (sidebarCollapsed || sidebarAnimating) && "overflow-hidden",
              !isSidebarResizing && "transition-[width] duration-200 ease-in-out",
            )}
            style={{ width: sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth }}
            onTransitionEnd={(e) => {
              if (e.target === e.currentTarget && e.propertyName === "width") {
                setSidebarAnimating(false);
              }
            }}
          >
            <div
              className={cn(
                "absolute inset-y-0 left-0 transition-[opacity,visibility] duration-200",
                sidebarCollapsed ? "visible opacity-100" : "invisible opacity-0",
              )}
            >
              <CollapsedSidebar onExpand={() => setSidebarCollapsed(false)} />
            </div>
            <div
              className={cn(
                "absolute inset-y-0 left-0 transition-[opacity,visibility] duration-200",
                sidebarCollapsed ? "invisible opacity-0" : "visible opacity-100",
              )}
              style={{ width: sidebarWidth }}
            >
              <ResizablePanel
                width={sidebarWidth}
                onWidthChange={(w) => useUIStore.getState().setSidebarWidth(w)}
                isResizing={isSidebarResizing}
                onResizingChange={handleSidebarResizing}
                minWidth={MIN_SIDEBAR_WIDTH}
                maxWidth={window.innerWidth * 0.99}
                handleSide="right"
                onDoubleClickHandle={() =>
                  useUIStore.getState().setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
                }
              >
                <Sidebar />
              </ResizablePanel>
            </div>
          </div>

          {/* Content */}
          <div className="flex flex-1 min-w-0 min-h-0">
            {!selectedWorktree ? (
              generalTerminalActive && homeDirPath ? (
                <SplitTreeRenderer
                  tree={generalTerminalSplitTree}
                  focusedPaneId={generalTerminalFocusedPaneId}
                  onFocusPane={handleGeneralTerminalFocusPane}
                  onRatioChange={(splitId, ratio) => {
                    const s = useUIStore.getState();
                    s.setGeneralTerminalSplitTree(
                      updateRatio(s.generalTerminalSplitTree, splitId, ratio),
                    );
                  }}
                  renderLeaf={(group, isFocused) => (
                    <GeneralTerminalLeaf
                      paneId={group.activeTabId}
                      worktreePath={homeDirPath}
                      cwd={homeDirPath}
                      isFocused={isFocused}
                      sessionId={generalTerminalPaneSessions[group.activeTabId] ?? null}
                      onSessionSpawned={handleGeneralTerminalSessionSpawned}
                    />
                  )}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                  Select a worktree
                </div>
              )
            ) : (
              <div className="relative flex-1 min-w-0">
                {/* Solid bg — xterm's WebGL canvas is on its own GPU layer
                    and doesn't reliably respect the parent's
                    `visibility: hidden` under WebKit, so without a backdrop
                    here it bleeds through the Diff view. */}
                <div
                  className={`absolute inset-0 bg-background ${activeTab === "diff" ? "z-10" : "z-0 invisible"}`}
                >
                  <DiffView onRevealInFiles={revealInFiles} />
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

          {/* Stays mounted at width 0 while closed so both open and close can
              animate; the panel content unmounts once the close transition
              ends. The panel keeps its full width inside, so shrinking the
              container reads as a slide, not a squish. */}
          {!generalTerminalActive && (
            <div
              className={cn(
                "relative h-full shrink-0",
                (!showSidebar || rightSidebarAnimating) && "overflow-hidden",
                !isRightSidebarResizing &&
                  "transition-[width] duration-200 ease-in-out",
              )}
              style={{ width: showSidebar ? rightSidebarWidth : 0 }}
              onTransitionEnd={(e) => {
                if (e.target === e.currentTarget && e.propertyName === "width") {
                  setRightSidebarAnimating(false);
                }
              }}
            >
              {(showSidebar || rightSidebarAnimating) && (
                <ResizablePanel
                  width={rightSidebarWidth}
                  onWidthChange={(w) => useUIStore.getState().setRightSidebarWidth(w)}
                  isResizing={isRightSidebarResizing}
                  onResizingChange={handleRightSidebarResizing}
                  minWidth={MIN_RIGHT_SIDEBAR_WIDTH}
                  maxWidth={window.innerWidth * 0.99}
                  handleSide="left"
                  onDoubleClickHandle={() =>
                    useUIStore
                      .getState()
                      .setRightSidebarWidth(DEFAULT_RIGHT_SIDEBAR_WIDTH)
                  }
                >
                  <RightSidebar
                    activeTab={rightSidebarTab}
                    onActiveTabChange={setRightSidebarTab}
                  />
                </ResizablePanel>
              )}
            </div>
          )}
        </div>
      </WorkerPoolContextProvider>
    </>
  );
}
