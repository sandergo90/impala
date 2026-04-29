import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { XtermTerminal, releaseCachedTerminal } from "./XtermTerminal";
import { FileViewer } from "./FileViewer";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useUIStore, useDataStore } from "../store";
import type { SplitNode, UserTab, WorktreeIssue } from "../types";
import { encodePtyInput } from "../lib/encode-pty";
import { getHookPort } from "../lib/get-hook-port";
import { sanitizeEventId } from "../lib/sanitize-event-id";
import { useAppHotkey } from "../hooks/useAppHotkey";
import { resolveAgent, resolveFlags, buildLaunchCommand } from "../lib/agent";
import {
  AGENT_PANE_ID,
  RUN_PANE_ID,
  userTabPaneId,
  runPtySessionId,
} from "../lib/pane-ids";
import {
  createUserTab,
  closeUserTab,
  renameUserTab,
  reorderUserTabs,
  setUserTabFocusedPane,
  getEffectiveUserTabSplitTree,
  getEffectiveUserTabFocusedPaneId,
} from "../lib/tab-actions";

type TabKind = "terminal" | "agent" | "file";

// Stable empty array — returning `[]` from the userTabs selector would create
// a new reference every call, breaking Zustand's useSyncExternalStore snapshot
// equality and triggering an infinite re-render loop.
const EMPTY_USER_TABS: UserTab[] = [];

interface ProjectConfig {
  setup?: string | null;
  run?: string | null;
}

interface TabDescriptor {
  id: string;
  label: string;
  kind: TabKind;
  useContinueFlag: boolean;
  paneId: string;
  isSystem: boolean;
}

/**
 * Tabbed terminals view for a single worktree.
 *
 * System tabs: Agent (always) and Run (when config.setup or config.run is set).
 * User tabs: from nav.userTabs, created via the plus button.
 *
 * When `agentOnly` is true, the tab strip + plus button are hidden and only
 * the primary Agent body renders — used by the top-level Split tab so the
 * agent sits next to the diff.
 */
export const TabbedTerminals = memo(function TabbedTerminals({
  worktreePath,
  isActive,
  agentOnly = false,
}: {
  worktreePath: string;
  isActive: boolean;
  agentOnly?: boolean;
}) {
  const activeTerminalsTab = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.activeTerminalsTab ?? AGENT_PANE_ID,
  );
  const userTabs = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.userTabs ?? EMPTY_USER_TABS,
  );
  const dataState = useDataStore((s) => s.worktreeDataStates[worktreePath]);
  const paneSessions = dataState?.paneSessions ?? {};

  const [config, setConfig] = useState<ProjectConfig | null>(null);
  useEffect(() => {
    const projectPath = useUIStore.getState().selectedProject?.path;
    if (!projectPath) {
      setConfig({});
      return;
    }
    invoke<ProjectConfig>("read_project_config", { projectPath })
      .then((c) => setConfig(c ?? {}))
      .catch(() => setConfig({}));
  }, [worktreePath]);

  const hasRunTab = Boolean(config?.setup?.trim() || config?.run?.trim());

  useEffect(() => {
    if (!hasRunTab) return;

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const sessionId = sanitizeEventId(runPtySessionId(worktreePath));
    listen<number>(`pty-exit-${sessionId}`, (event) => {
      const code = event.payload;
      useUIStore.getState().updateWorktreeNavState(worktreePath, {
        runStatus: "idle",
        runExitCode: code,
        hasUnreadRunFailure: code !== 0,
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [worktreePath, hasRunTab]);

  useEffect(() => {
    if (!isActive) return;
    if (activeTerminalsTab !== RUN_PANE_ID) return;
    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    if (!nav.hasUnreadRunFailure) return;
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      hasUnreadRunFailure: false,
    });
  }, [worktreePath, isActive, activeTerminalsTab]);

  const tabs: TabDescriptor[] = useMemo(() => {
    const out: TabDescriptor[] = [];
    if (hasRunTab) {
      out.push({
        id: RUN_PANE_ID,
        label: "Run",
        kind: "terminal",
        useContinueFlag: false,
        paneId: RUN_PANE_ID,
        isSystem: true,
      });
    }
    out.push({
      id: AGENT_PANE_ID,
      label: "Agent",
      kind: "agent",
      useContinueFlag: true,
      paneId: AGENT_PANE_ID,
      isSystem: true,
    });
    for (const t of userTabs) {
      out.push({
        id: t.id,
        label: t.label,
        kind: t.kind,
        useContinueFlag: false,
        paneId: userTabPaneId(t.id),
        isSystem: false,
      });
    }
    return out;
  }, [hasRunTab, userTabs]);

  // Map of tab id -> whether it's an unpinned file preview tab. Used to
  // render preview labels in italic.
  const isPreviewById = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const t of userTabs) {
      if (t.kind === "file" && !t.pinned) m.set(t.id, true);
    }
    return m;
  }, [userTabs]);

  const activeId: string = tabs.some((t) => t.id === activeTerminalsTab)
    ? activeTerminalsTab
    : AGENT_PANE_ID;

  const setActive = useCallback(
    (id: string) => {
      if (id === activeTerminalsTab) return;
      useUIStore
        .getState()
        .updateWorktreeNavState(worktreePath, { activeTerminalsTab: id });
    },
    [worktreePath, activeTerminalsTab],
  );

  const handleCloseUserTab = useCallback(
    (tabId: string) => closeUserTab(worktreePath, tabId),
    [worktreePath],
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require a 5px drag before activation so clicks on the label button
      // and close button still register as clicks, not drags.
      activationConstraint: { distance: 5 },
    }),
  );

  const userTabIds = useMemo(() => userTabs.map((t) => t.id), [userTabs]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const fromId = String(active.id);
      const toId = String(over.id);
      if (fromId === toId) return;
      reorderUserTabs(worktreePath, fromId, toId);
    },
    [worktreePath],
  );

  const startRenaming = useCallback((tabId: string, currentLabel: string) => {
    setEditingTabId(tabId);
    setEditingLabel(currentLabel);
  }, []);

  const commitRename = useCallback(() => {
    if (editingTabId !== null) {
      renameUserTab(worktreePath, editingTabId, editingLabel);
    }
    setEditingTabId(null);
    setEditingLabel("");
  }, [worktreePath, editingTabId, editingLabel]);

  const cancelRename = useCallback(() => {
    setEditingTabId(null);
    setEditingLabel("");
  }, []);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (caretRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const handleNewTerminal = useCallback(() => {
    setMenuOpen(false);
    createUserTab(worktreePath, "terminal");
  }, [worktreePath]);

  const handleNewAgent = useCallback(() => {
    setMenuOpen(false);
    createUserTab(worktreePath, "agent");
  }, [worktreePath]);

  if (agentOnly) {
    return (
      <div className="relative h-full w-full">
        <TabBody
          paneId={AGENT_PANE_ID}
          kind="agent"
          useContinueFlag
          worktreePath={worktreePath}
          sessionId={paneSessions[AGENT_PANE_ID] ?? null}
          isActive={isActive}
        />
      </div>
    );
  }

  const renderTabInner = (t: TabDescriptor): ReactNode => (
    <>
      {editingTabId === t.id ? (
        <input
          autoFocus
          value={editingLabel}
          onChange={(e) => setEditingLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          }}
          onBlur={commitRename}
          onFocus={(e) => e.currentTarget.select()}
          className="mx-3 my-1.5 w-24 bg-background border border-border rounded px-1 text-[15px] font-medium outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <button
          onClick={() => setActive(t.id)}
          onDoubleClick={() => {
            // Don't rename file tabs — their label is the file basename and
            // is auto-managed by openFileTab.
            if (!t.isSystem && t.kind !== "file") startRenaming(t.id, t.label);
          }}
          className={`px-3.5 py-2 text-[15px] font-medium transition-colors flex items-center gap-1.5 ${
            isPreviewById.get(t.id) ? "italic" : ""
          }`}
        >
          {t.label}
        </button>
      )}
      {!t.isSystem && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleCloseUserTab(t.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="mr-1 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background/50 transition-opacity"
          aria-label={`Close ${t.label}`}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 3L13 13M13 3L3 13"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </>
  );

  const systemTabs = tabs.filter((t) => t.isSystem);
  const userTabDescriptors = tabs.filter((t) => !t.isSystem);

  const baseTabClass = (t: TabDescriptor) =>
    `group flex items-center ${
      activeId === t.id
        ? "text-foreground bg-accent"
        : "text-muted-foreground hover:text-foreground"
    } rounded-t`;

  return (
    <div className="flex flex-col h-full">
      <div className="flex shrink-0 items-center gap-0.5 px-2 pt-1.5 border-b border-border/40">
        {systemTabs.map((t) => (
          <div key={t.id} className={baseTabClass(t)}>
            {renderTabInner(t)}
          </div>
        ))}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={userTabIds}
            strategy={horizontalListSortingStrategy}
          >
            {userTabDescriptors.map((t) => (
              <SortableUserTab
                key={t.id}
                tabId={t.id}
                disabled={editingTabId === t.id}
                className={baseTabClass(t)}
              >
                {renderTabInner(t)}
              </SortableUserTab>
            ))}
          </SortableContext>
        </DndContext>


        <div className="relative flex items-center ml-1">
          <button
            onClick={handleNewTerminal}
            className="px-1.5 py-1 text-muted-foreground hover:text-foreground rounded-l hover:bg-accent"
            aria-label="New terminal tab"
            title="New terminal tab"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 3V13M3 8H13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            ref={caretRef}
            onClick={() => setMenuOpen((o) => !o)}
            className="px-1 py-1 text-muted-foreground hover:text-foreground rounded-r hover:bg-accent"
            aria-label="New tab menu"
            aria-expanded={menuOpen}
          >
            <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
              <path
                d="M3 6L8 11L13 6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute top-full left-0 mt-1 z-20 min-w-[160px] rounded border border-border bg-background shadow-lg py-1"
            >
              <button
                onClick={handleNewTerminal}
                className="block w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
              >
                New terminal tab
              </button>
              <button
                onClick={handleNewAgent}
                className="block w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
              >
                New Agent tab
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        {(() => {
          // Mount only the active tab. Hidden tabs unmount, which detaches
          // the cached xterm wrapper from the DOM. On reactivation the
          // XtermTerminal effect re-runs attach() — appendChild + fit() +
          // refresh() — so xterm picks up any size drift from the hidden
          // period and TUIs get a real SIGWINCH if dims
          // actually changed. The cached terminal entry survives because it
          // lives in a module-level Map, not React state.
          const t = tabs.find((tab) => tab.id === activeId);
          if (!t) return null;
          const userTab = !t.isSystem
            ? userTabs.find((u) => u.id === t.id) ?? null
            : null;
          return (
            <div key={t.id} className="absolute inset-0">
              {userTab && userTab.kind === "file" ? (
                <FileViewer />
              ) : userTab ? (
                <UserTabSplitRenderer
                  tab={userTab}
                  worktreePath={worktreePath}
                  paneSessions={paneSessions}
                  isActive={isActive}
                />
              ) : (
                <TabBody
                  paneId={t.paneId}
                  kind={t.kind === "file" ? "terminal" : t.kind}
                  useContinueFlag={t.useContinueFlag}
                  worktreePath={worktreePath}
                  sessionId={paneSessions[t.paneId] ?? null}
                  isActive={isActive}
                />
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
});

/**
 * Renders one tab body. Lazy-spawns the PTY on first mount.
 * Agent tabs additionally write the agent's launch command on first spawn.
 * `useContinueFlag` controls whether the primary Agent tab resumes the
 * prior session.
 */
const TabBody = memo(function TabBody({
  paneId,
  kind,
  useContinueFlag,
  worktreePath,
  sessionId,
  isActive,
}: {
  paneId: string;
  kind: TabKind;
  useContinueFlag: boolean;
  worktreePath: string;
  sessionId: string | null;
  isActive: boolean;
}) {
  const spawningRef = useRef(false);

  useEffect(() => {
    if (sessionId || spawningRef.current) return;
    spawningRef.current = true;

    if (kind === "agent" && useContinueFlag) {
      const linearApiKey = useUIStore.getState().linearApiKey;
      if (linearApiKey) {
        invoke<WorktreeIssue | null>("get_worktree_issue", { worktreePath })
          .then((issue) => {
            if (issue) {
              invoke("refresh_linear_context", {
                apiKey: linearApiKey,
                issueId: issue.issue_id,
                worktreePath,
              }).catch(() => {});
            }
          })
          .catch(() => {});
      }
    }

    const ptyId = `pty-${paneId}-${worktreePath}`;

    getHookPort().then(async (hookPort) => {
      const projectPath =
        useUIStore.getState().selectedProject?.path ?? worktreePath;
      const agent = await resolveAgent(worktreePath, projectPath);
      let extraEnv: Record<string, string> = {};
      try {
        extraEnv = await invoke<Record<string, string>>("prepare_agent_config", {
          worktreePath,
          agent,
        });
      } catch (err) {
        console.warn("Failed to prepare agent config:", err);
      }
      invoke<boolean>("pty_spawn", {
        sessionId: ptyId,
        cwd: worktreePath,
        command: null,
        envVars: {
          IMPALA_HOOK_PORT: String(hookPort),
          IMPALA_WORKTREE_PATH: worktreePath,
          ...extraEnv,
        },
      })
        .then(async (isNew) => {
          const data = useDataStore.getState().getWorktreeDataState(worktreePath);
          useDataStore.getState().updateWorktreeDataState(worktreePath, {
            paneSessions: { ...data.paneSessions, [paneId]: ptyId },
          });

          if (kind === "agent" && isNew) {
            const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
            const agentLaunched = nav.agentLaunched;

            const flags = await resolveFlags(agent, projectPath);
            const launched = useContinueFlag && agentLaunched;
            const cmd = buildLaunchCommand(agent, flags, launched);
            const encoded = encodePtyInput(cmd);
            invoke("pty_write", { sessionId: ptyId, data: encoded }).catch(
              () => {},
            );

            if (useContinueFlag && !agentLaunched) {
              useUIStore
                .getState()
                .updateWorktreeNavState(worktreePath, { agentLaunched: true });
            }
          }
        })
        .catch((err) => {
          console.error("Failed to spawn PTY:", err);
          spawningRef.current = false;
        });
    });
  }, [paneId, kind, useContinueFlag, worktreePath, sessionId]);

  const handleRestart = useCallback(() => {
    if (!sessionId) return;
    invoke("pty_kill", { sessionId }).catch(() => {});
    releaseCachedTerminal(sessionId);
    const data = useDataStore.getState().getWorktreeDataState(worktreePath);
    const { [paneId]: _removed, ...remaining } = data.paneSessions;
    useDataStore
      .getState()
      .updateWorktreeDataState(worktreePath, { paneSessions: remaining });
  }, [sessionId, paneId, worktreePath]);

  useAppHotkey("RESTART_SESSION", handleRestart, { enabled: isActive }, [handleRestart]);

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Starting terminal...
      </div>
    );
  }

  return (
    <XtermTerminal
      key={sessionId}
      sessionId={sessionId}
      baseDir={worktreePath}
      isFocused={isActive}
      onRestart={handleRestart}
    />
  );
});

function UserTabSplitRenderer({
  tab,
  worktreePath,
  paneSessions,
  isActive,
}: {
  tab: UserTab;
  worktreePath: string;
  paneSessions: Record<string, string>;
  isActive: boolean;
}) {
  return (
    <SplitNodeRenderer
      node={getEffectiveUserTabSplitTree(tab)}
      tabId={tab.id}
      worktreePath={worktreePath}
      paneSessions={paneSessions}
      focusedPaneId={getEffectiveUserTabFocusedPaneId(tab)}
      isActive={isActive}
    />
  );
}

function SplitNodeRenderer({
  node,
  tabId,
  worktreePath,
  paneSessions,
  focusedPaneId,
  isActive,
}: {
  node: SplitNode;
  tabId: string;
  worktreePath: string;
  paneSessions: Record<string, string>;
  focusedPaneId: string;
  isActive: boolean;
}) {
  if (node.type === "leaf") {
    const isFocused = node.id === focusedPaneId;
    const paneKind: TabKind = node.paneType === "agent" ? "agent" : "terminal";
    return (
      <div
        className="h-full w-full relative"
        style={{
          opacity: isFocused || !isActive ? 1 : 0.6,
          transition: "opacity 150ms ease",
        }}
        onMouseDownCapture={() => {
          if (!isFocused) setUserTabFocusedPane(worktreePath, tabId, node.id);
        }}
      >
        <TabBody
          paneId={node.id}
          kind={paneKind}
          useContinueFlag={false}
          worktreePath={worktreePath}
          sessionId={paneSessions[node.id] ?? null}
          isActive={isActive && isFocused}
        />
      </div>
    );
  }

  // SplitNode.orientation is the divider line; ResizablePanelGroup.orientation
  // is the opposite (stacking axis). horizontal divider → vertical stack.
  const panelOrientation =
    node.orientation === "horizontal" ? "vertical" : "horizontal";
  const firstPercent = Math.round(node.ratio * 100);

  return (
    <ResizablePanelGroup orientation={panelOrientation} className="h-full w-full">
      <ResizablePanel defaultSize={`${firstPercent}%`} minSize={10}>
        <SplitNodeRenderer
          node={node.first}
          tabId={tabId}
          worktreePath={worktreePath}
          paneSessions={paneSessions}
          focusedPaneId={focusedPaneId}
          isActive={isActive}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={`${100 - firstPercent}%`} minSize={10}>
        <SplitNodeRenderer
          node={node.second}
          tabId={tabId}
          worktreePath={worktreePath}
          paneSessions={paneSessions}
          focusedPaneId={focusedPaneId}
          isActive={isActive}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function SortableUserTab({
  tabId,
  disabled,
  className,
  children,
}: {
  tabId: string;
  disabled: boolean;
  className: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tabId, disabled });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    cursor: disabled ? undefined : "grab",
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={className}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

