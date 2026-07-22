import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@/lib/invoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCenter,
  DragOverlay,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Bot, FileText, Globe2, GripVertical, Terminal, X } from "lucide-react";
import { XtermTerminal, releaseCachedTerminal } from "./XtermTerminal";
import { FileViewer } from "./FileViewer";
import { BrowserPane } from "./BrowserPane";
import { SplitTreeRenderer } from "./SplitTreeRenderer";
import { useUIStore, useDataStore } from "../store";
import type { PaneContent, ProjectConfig, UserTab, WorktreeIssue } from "../types";
import type { SplitGroup } from "../lib/split-tree";
import { getActiveGroupTab, getLeaves } from "../lib/split-tree";
import { encodePtyInput } from "../lib/encode-pty";
import { getHookPort } from "../lib/get-hook-port";
import { sanitizeEventId } from "../lib/sanitize-event-id";
import { useAppHotkey } from "../hooks/useAppHotkey";
import { resolveAgent, resolveFlags, buildLaunchCommand } from "../lib/agent";
import { awaitShellReady, markShellReady } from "../lib/pty-ready";
import {
  AGENT_PANE_ID,
  RUN_PANE_ID,
  userTabPaneId,
  runPtySessionId,
} from "../lib/pane-ids";
import {
  createUserTab,
  createBrowserTab,
  closeUserTab,
  renameUserTab,
  getPendingAgentLaunch,
  clearPendingAgentLaunch,
  setUserTabFocusedPane,
  updateUserTabRatio,
  getEffectiveUserTabSplitTree,
  getEffectiveUserTabFocusedPaneId,
  setAgentTabFocusedPane,
  updateAgentTabRatio,
  getEffectiveAgentTabSplitTree,
  getEffectiveAgentTabFocusedPaneId,
  splitActiveTabPane,
  setUserGroupActiveTab,
  setAgentGroupActiveTab,
  closeUserTabFocusedPane,
  closeAgentTabFocusedPane,
  moveWorkspaceTab,
  type WorkspaceTabDragSource,
  type WorkspaceTabDropTarget,
} from "../lib/tab-actions";
import { useEditorDocsStore } from "../stores/editor-docs";
import { useShallow } from "zustand/shallow";
import { buildDocumentKey } from "../lib/editor-buffer-registry";
import { useBrowserAgentActivity } from "../hooks/useBrowserAgentActivity";

type TabKind = "terminal" | "agent" | "file" | "browser";

// Stable empty array — returning `[]` from the userTabs selector would create
// a new reference every call, breaking Zustand's useSyncExternalStore snapshot
// equality and triggering an infinite re-render loop.
const EMPTY_USER_TABS: UserTab[] = [];
const EMPTY_PANE_SESSIONS: Record<string, string> = {};

interface TabDescriptor {
  id: string;
  label: string;
  kind: TabKind;
  isPrimaryAgent: boolean;
  paneId: string;
  isSystem: boolean;
}

interface WorkspaceTabDragData {
  source: WorkspaceTabDragSource;
  label: string;
  kind: TabKind;
}

interface WorkspaceTabDropData {
  dropTarget: WorkspaceTabDropTarget;
}

const topTabDndId = (tabId: string) => `top-tab:${tabId}`;
const groupTabDndId = (ownerTopTabId: string, groupId: string, tabId: string) =>
  `group-tab:${ownerTopTabId}:${groupId}:${tabId}`;

/**
 * Tabbed terminals view for a single worktree.
 *
 * System tabs: Agent (always) and Run (when config.setup is set or any actions exist).
 * User tabs: from nav.userTabs, created via the plus button.
 */
export const TabbedTerminals = memo(function TabbedTerminals({
  worktreePath,
  isActive,
}: {
  worktreePath: string;
  isActive: boolean;
}) {
  const activeTerminalsTab = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.activeTerminalsTab ?? AGENT_PANE_ID,
  );
  const userTabs = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.userTabs ?? EMPTY_USER_TABS,
  );
  // Subscribe to just paneSessions, not the whole data-state object, so
  // unrelated field updates (agentStatus, commits, ...) don't re-render the
  // terminal tree.
  const paneSessions = useDataStore(
    (s) => s.worktreeDataStates[worktreePath]?.paneSessions ?? EMPTY_PANE_SESSIONS,
  );

  const [config, setConfig] = useState<ProjectConfig | null>(null);
  useEffect(() => {
    const projectPath = useUIStore.getState().selectedProject?.path;
    if (!projectPath) {
      setConfig(null);
      return;
    }
    invoke<ProjectConfig>("read_project_config", { projectPath })
      .then((c) => setConfig(c))
      .catch(() => setConfig(null));
  }, [worktreePath]);

  const hasRunTab = Boolean(
    config?.setup?.trim() || (config?.actions.length ?? 0) > 0,
  );

  const { active: browserAgentActive } = useBrowserAgentActivity(worktreePath);

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
        isPrimaryAgent: false,
        paneId: RUN_PANE_ID,
        isSystem: true,
      });
    }
    out.push({
      id: AGENT_PANE_ID,
      label: "Agent",
      kind: "agent",
      isPrimaryAgent: true,
      paneId: AGENT_PANE_ID,
      isSystem: true,
    });
    for (const t of userTabs) {
      out.push({
        id: t.id,
        label: t.label,
        kind: t.kind,
        isPrimaryAgent: false,
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

  // Map of tab id -> whether the file's editor buffer is dirty. Drives the
  // unsaved-changes dot in the tab label. The selector projects only dirty
  // doc keys for this worktree so unrelated keystrokes don't re-render us.
  const dirtyDocKeys = useEditorDocsStore(
    useShallow((s) => {
      const out: Record<string, true> = {};
      for (const k in s.docs) {
        const d = s.docs[k];
        if (d.worktreePath === worktreePath && d.dirty) out[k] = true;
      }
      return out;
    }),
  );
  const isDirtyById = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const t of userTabs) {
      if (t.kind === "file" && t.path && dirtyDocKeys[buildDocumentKey(worktreePath, t.path)]) {
        m.set(t.id, true);
      }
    }
    return m;
  }, [userTabs, dirtyDocKeys, worktreePath]);

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
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const userTabIds = useMemo(
    () => userTabs.map((t) => topTabDndId(t.id)),
    [userTabs],
  );

  const [dragPreview, setDragPreview] = useState<{
    label: string;
    kind: TabKind;
  } | null>(null);

  const finishDrag = useCallback(() => {
    setDragPreview(null);
    useUIStore.getState().setPanelDragActive(false);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as WorkspaceTabDragData | undefined;
    if (!data?.source) return;
    setDragPreview({ label: data.label, kind: data.kind });
    useUIStore.getState().setPanelDragActive(true);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      try {
        const source = (event.active.data.current as WorkspaceTabDragData | undefined)
          ?.source;
        const target = (event.over?.data.current as WorkspaceTabDropData | undefined)
          ?.dropTarget;
        if (source && target) moveWorkspaceTab(worktreePath, source, target);
      } finally {
        finishDrag();
      }
    },
    [finishDrag, worktreePath],
  );

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    finishDrag();
  }, [finishDrag]);

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

  const handleNewBrowser = useCallback(() => {
    setMenuOpen(false);
    createBrowserTab(worktreePath);
  }, [worktreePath]);

  const renderTabInner = (t: TabDescriptor): ReactNode => {
    const TabIcon =
      t.kind === "agent"
        ? Bot
        : t.kind === "file"
          ? FileText
          : t.kind === "browser"
            ? Globe2
            : Terminal;

    return (
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
          className="mx-2 h-7 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-[0.9375rem] font-medium outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={activeId === t.id}
          onClick={() => setActive(t.id)}
          onDoubleClick={() => {
            // Don't rename file tabs — their label is the file basename and
            // is auto-managed by openFileTab.
            if (!t.isSystem && t.kind !== "file") startRenaming(t.id, t.label);
          }}
          className={`flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-l-md pl-3 text-left text-[0.9375rem] font-medium leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
            isPreviewById.get(t.id) ? "italic" : ""
          }`}
          title={t.label}
        >
          <TabIcon aria-hidden="true" className="size-4 shrink-0 opacity-90" />
          {isDirtyById.get(t.id) && (
            <span className="shrink-0 text-foreground" aria-label="Unsaved">●</span>
          )}
          {t.kind === "browser" && browserAgentActive && (
            <span
              className="text-primary animate-pulse"
              aria-label="Agent using browser"
            >
              ●
            </span>
          )}
          <span className="truncate">{t.label}</span>
        </button>
      )}
      {!t.isSystem && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleCloseUserTab(t.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={`mr-1.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-opacity hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${
            activeId === t.id
              ? "opacity-70"
              : "opacity-0 group-hover:opacity-70 focus:opacity-70"
          }`}
          aria-label={`Close ${t.label}`}
          title={`Close ${t.label}`}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      )}
      </>
    );
  };

  const systemTabs = tabs.filter((t) => t.isSystem);
  const userTabDescriptors = tabs.filter((t) => !t.isSystem);

  const baseTabClass = (t: TabDescriptor) =>
    `group flex h-9 min-w-[132px] max-w-[280px] shrink-0 items-center rounded-md transition-colors ${
      activeId === t.id
        ? "bg-accent text-foreground shadow-sm"
        : "text-foreground/70 hover:bg-accent/60 hover:text-foreground"
    }`;

  const topLevelTabList = (
      <TopLevelDropZone appendIndex={userTabs.length}>
        {systemTabs.map((t) => (
          <div key={t.id} className={baseTabClass(t)}>
            {renderTabInner(t)}
          </div>
        ))}

        <SortableContext
          items={userTabIds}
          strategy={horizontalListSortingStrategy}
        >
            {userTabDescriptors.map((t, index) => (
              <SortableWorkspaceTab
                key={t.id}
                dndId={topTabDndId(t.id)}
                disabled={editingTabId === t.id}
                className={baseTabClass(t)}
                dragData={{
                  source: { type: "top-level", topTabId: t.id },
                  label: t.label,
                  kind: t.kind,
                }}
                dropTarget={{ type: "top-level", index }}
              >
                {renderTabInner(t)}
              </SortableWorkspaceTab>
            ))}
        </SortableContext>


        <div className="relative ml-0.5 flex shrink-0 items-center">
          <button
            type="button"
            onClick={handleNewTerminal}
            className="flex size-8 items-center justify-center rounded-l-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="New terminal tab"
            title="New terminal tab"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
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
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="flex h-8 w-5 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
              className="absolute top-full left-0 mt-1 z-20 min-w-[160px] rounded border border-border bg-popover text-popover-foreground shadow-lg py-1"
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
              <button
                onClick={handleNewBrowser}
                className="block w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
              >
                New browser tab
              </button>
            </div>
          )}
        </div>

      </TopLevelDropZone>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="h-full">
        <div className="relative h-full min-h-0">
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
              {userTab ? (
                // Every user tab renders through its split tree; the leaf
                // renderer dispatches on content.kind (agent/shell/file/browser).
                <UserTabSplitRenderer
                  tab={userTab}
                  worktreePath={worktreePath}
                  paneSessions={paneSessions}
                  isActive={isActive}
                  primaryTabList={topLevelTabList}
                />
              ) : t.id === AGENT_PANE_ID ? (
                // The Agent system tab is splittable too (agent + shell side by
                // side is the headline case); its split state lives on nav.
                <AgentTabSplitRenderer
                  worktreePath={worktreePath}
                  paneSessions={paneSessions}
                  isActive={isActive}
                  primaryTabList={topLevelTabList}
                />
              ) : (
                // The Run tab is unsplittable but still owns the same left-pane tab row.
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex h-11 shrink-0 items-center border-b border-border/70 bg-sidebar px-2 py-1">
                    {topLevelTabList}
                  </div>
                  <div className="relative min-h-0 flex-1">
                    <TabBody
                      paneId={t.paneId}
                      kind={t.kind === "agent" ? "agent" : "terminal"}
                      isPrimaryAgent={t.isPrimaryAgent}
                      worktreePath={worktreePath}
                      sessionId={paneSessions[t.paneId] ?? null}
                      isActive={isActive}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })()}
        </div>
      </div>
      <DragOverlay>
        {dragPreview ? <WorkspaceTabDragPreview {...dragPreview} /> : null}
      </DragOverlay>
    </DndContext>
  );
});

/**
 * Renders one tab body. Lazy-spawns the PTY on first mount.
 * Agent tabs additionally write the agent's launch command on first spawn.
 * `isPrimaryAgent` marks the worktree's main Agent tab — the one auto-launched
 * once (on first open) and given the linked issue's initial prompt. Secondary
 * agent panes always launch bare.
 */
const TabBody = memo(function TabBody({
  paneId,
  kind,
  isPrimaryAgent,
  worktreePath,
  sessionId,
  isActive,
}: {
  paneId: string;
  kind: "terminal" | "agent";
  isPrimaryAgent: boolean;
  worktreePath: string;
  sessionId: string | null;
  isActive: boolean;
}) {
  const spawningRef = useRef(false);

  useEffect(() => {
    if (sessionId || spawningRef.current) return;
    spawningRef.current = true;

    // Look up the linked issue in parallel with pty_spawn. Its identifier
    // feeds the agent's initial prompt on a fresh launch, and its issue_id
    // feeds the context-file refresh.
    const issuePromise: Promise<WorktreeIssue | null> =
      kind === "agent" && isPrimaryAgent
        ? invoke<WorktreeIssue | null>("get_worktree_issue", { worktreePath }).catch(
            () => null,
          )
        : Promise.resolve(null);

    // Kick off the issue context refresh in parallel. 5-min rate-limited
    // backend-side, so usually a no-op. We await it later before building
    // the launch command so the file is current when the agent reads it.
    const refreshPromise: Promise<void> = (async () => {
      if (kind !== "agent" || !isPrimaryAgent) return;
      const projectPath = useUIStore.getState().selectedProject?.path ?? worktreePath;
      const issue = await issuePromise;
      if (!issue) return;
      await invoke("write_issue_context", {
        projectPath,
        issueId: issue.issue_id,
        worktreePath,
        force: false,
      }).catch(() => {});
    })();

    const ptyId = `pty-${paneId}-${worktreePath}`;

    getHookPort().then(async (hookPort) => {
      const projectPath =
        useUIStore.getState().selectedProject?.path ?? worktreePath;
      const delegatedLaunch = getPendingAgentLaunch(paneId);
      const agent = delegatedLaunch?.agent ?? (await resolveAgent(worktreePath));
      let extraEnv: Record<string, string> = {};
      try {
        extraEnv = await invoke<Record<string, string>>("prepare_agent_config", {
          worktreePath,
          agent,
        });
      } catch (err) {
        console.warn("Failed to prepare agent config:", err);
      }
      const launch = await invoke<{
        shell_path: string;
        shell_args: string[];
        env: Record<string, string>;
      }>("prepare_shell_launch");
      invoke<boolean>("pty_spawn", {
        sessionId: ptyId,
        cwd: worktreePath,
        command: null,
        shellPath: launch.shell_path,
        shellArgs: launch.shell_args,
        envVars: {
          ...launch.env,
          ...extraEnv,
          IMPALA_HOOK_PORT: String(hookPort),
          IMPALA_WORKTREE_PATH: worktreePath,
          IMPALA_PANE_ID: paneId,
        },
      })
        .then(async (isNew) => {
          const data = useDataStore.getState().getWorktreeDataState(worktreePath);
          useDataStore.getState().updateWorktreeDataState(worktreePath, {
            paneSessions: { ...data.paneSessions, [paneId]: ptyId },
          });

          if (!isNew) {
            // Re-attaching to a PTY that survived restart — its shell is past
            // prompt-1 by now, so don't wait on a marker that won't arrive.
            markShellReady(ptyId);
          }

          if (kind === "agent" && isNew) {
            const nav = useUIStore.getState().getWorktreeNavState(worktreePath);

            // The PTY daemon keeps live agent sessions across normal app
            // restarts (isNew=false → reattach above). A fresh PTY for the
            // primary agent that was already launched means the daemon lost
            // the session (crash / reboot / version upgrade); leave the shell
            // bare rather than relaunching. The agent is auto-launched exactly
            // once per worktree — on first open.
            if (isPrimaryAgent && nav.agentLaunched) return;

            const flags = await resolveFlags(agent, projectPath);

            // On first launch with a linked issue, point the agent at the
            // issue context file via its initial prompt so it reads the issue
            // body on demand instead of relying on autoloaded
            // CLAUDE.local.md / AGENTS.md.
            await refreshPromise;
            const issue = await issuePromise;
            const delegatedPrompt = delegatedLaunch?.prompt;
            const initialPrompt =
              delegatedPrompt ??
              (issue
                ? `Read the ${issue.provider} issue from @docs/issues/${issue.identifier}.md`
                : undefined);

            const cmd = buildLaunchCommand(agent, flags, initialPrompt, extraEnv);
            const encoded = encodePtyInput(cmd);

            // Wait for the shell to finish sourcing rc files before writing.
            // In release builds, pty_spawn resolves before zsh is interactive,
            // and writing immediately would dump raw bytes into the pre-prompt
            // input buffer.
            const reason = await awaitShellReady(ptyId);
            if (reason === "timed_out") {
              console.warn(
                `[pty] shell readiness timed out for ${ptyId}; writing anyway`,
              );
            }

            try {
              await invoke("pty_write", { sessionId: ptyId, data: encoded });
              if (delegatedLaunch) clearPendingAgentLaunch(paneId);
            } catch {
              // Keep a delegated prompt pending so a successful remount can
              // still deliver it.
            }

            if (isPrimaryAgent) {
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
  }, [paneId, kind, isPrimaryAgent, worktreePath, sessionId]);

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

function PaneSplitControl({
  onFocus,
  onSplit,
}: {
  onFocus: () => void;
  onSplit: (
    orientation: "horizontal" | "vertical",
    content: PaneContent,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    useUIStore.getState().setPanelDragActive(true);
    return () => useUIStore.getState().setPanelDragActive(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const split = (
    orientation: "horizontal" | "vertical",
    content: PaneContent,
  ) => {
    setOpen(false);
    onSplit(orientation, content);
  };

  return (
    <div className="relative flex shrink-0 items-center border-l border-border/50 pl-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          onFocus();
          setOpen((current) => !current);
        }}
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Split this pane"
        title="Split this pane"
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M12 3v18" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full z-30 mt-1 min-w-[180px] rounded border border-border bg-popover py-1 text-popover-foreground shadow-lg"
        >
          <div className="px-3 py-1 text-xs text-muted-foreground">Split right with</div>
          {(["agent", "shell", "browser"] as const).map((kind) => (
            <button
              key={`vertical-${kind}`}
              type="button"
              onClick={() => split("vertical", { kind })}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
            >
              {kind === "shell" ? "Terminal" : kind[0].toUpperCase() + kind.slice(1)}
            </button>
          ))}
          <div className="my-1 border-t border-border/60" />
          <div className="px-3 py-1 text-xs text-muted-foreground">Split down with</div>
          {(["agent", "shell", "browser"] as const).map((kind) => (
            <button
              key={`horizontal-${kind}`}
              type="button"
              onClick={() => split("horizontal", { kind })}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
            >
              {kind === "shell" ? "Terminal" : kind[0].toUpperCase() + kind.slice(1)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PaneTabGroup({
  group,
  topTabId,
  worktreePath,
  paneSessions,
  isActive,
  isFocused,
  onActivate,
  onClose,
  onFocus,
  onSplit,
  isSplitLayout,
  isPrimaryGroup,
  primaryTabList,
}: {
  group: SplitGroup;
  topTabId: string;
  worktreePath: string;
  paneSessions: Record<string, string>;
  isActive: boolean;
  isFocused: boolean;
  onActivate: (groupTabId: string) => void;
  onClose: (groupTabId: string) => void;
  onFocus: () => void;
  onSplit: (
    orientation: "horizontal" | "vertical",
    content: PaneContent,
  ) => void;
  isSplitLayout: boolean;
  isPrimaryGroup: boolean;
  primaryTabList: ReactNode;
}) {
  const activeTab = getActiveGroupTab(group);
  const content = activeTab.content;

  let body: ReactNode;
  if (content.kind === "file") {
    body = <FileViewer worktreePath={worktreePath} path={content.path} />;
  } else if (content.kind === "browser") {
    body = (
      <BrowserPane
        paneId={activeTab.id}
        tabId={topTabId}
        worktreePath={worktreePath}
        url={content.url}
        isActive={isActive}
        isFocused={isFocused}
      />
    );
  } else {
    body = (
      <TabBody
        paneId={activeTab.id}
        kind={content.kind === "agent" ? "agent" : "terminal"}
        isPrimaryAgent={activeTab.id === AGENT_PANE_ID}
        worktreePath={worktreePath}
        sessionId={paneSessions[activeTab.id] ?? null}
        isActive={isActive && isFocused}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 bg-sidebar px-2 py-1">
        {isPrimaryGroup ? (
          primaryTabList
        ) : (
          <PaneGroupDropZone
            ownerTopTabId={topTabId}
            groupId={group.id}
            appendIndex={group.tabs.length}
          >
            <SortableContext
              items={group.tabs.map((tab) =>
                groupTabDndId(topTabId, group.id, tab.id)
              )}
              strategy={horizontalListSortingStrategy}
            >
            {group.tabs.map((tab, index) => {
            const selected = tab.id === activeTab.id;
            const canClose =
              topTabId !== AGENT_PANE_ID || isSplitLayout || group.tabs.length > 1;
            const TabIcon =
              tab.content.kind === "agent"
                ? Bot
                : tab.content.kind === "file"
                  ? FileText
                  : tab.content.kind === "browser"
                    ? Globe2
                    : Terminal;

            return (
              <SortableWorkspaceTab
                key={tab.id}
                dndId={groupTabDndId(topTabId, group.id, tab.id)}
                disabled={false}
                dragData={{
                  source: {
                    type: "group-tab",
                    ownerTopTabId: topTabId,
                    groupId: group.id,
                    groupTabId: tab.id,
                  },
                  label: tab.label,
                  kind: tab.content.kind === "shell" ? "terminal" : tab.content.kind,
                }}
                dropTarget={{
                  type: "group",
                  ownerTopTabId: topTabId,
                  groupId: group.id,
                  index,
                }}
                className={`group/pane-tab flex h-9 min-w-[132px] max-w-[280px] shrink-0 items-center rounded-md transition-colors ${
                  selected
                    ? "bg-accent text-foreground shadow-sm"
                    : "text-foreground/70 hover:bg-accent/60 hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onActivate(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-l-md pl-3 text-left text-[0.9375rem] font-medium leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  title={tab.label}
                >
                  <TabIcon
                    aria-hidden="true"
                    className={`size-4 shrink-0 ${selected ? "opacity-90" : "opacity-75"}`}
                  />
                  <span className="truncate">{tab.label}</span>
                </button>
                {canClose && (
                  <button
                    type="button"
                    aria-label={`Close ${tab.label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose(tab.id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    className={`mr-1.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-opacity hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${
                      selected
                        ? "opacity-70"
                        : "opacity-0 group-hover/pane-tab:opacity-70 focus:opacity-70"
                    }`}
                    title={`Close ${tab.label}`}
                  >
                    <X aria-hidden="true" className="size-4" />
                  </button>
                )}
              </SortableWorkspaceTab>
            );
            })}
            </SortableContext>
          </PaneGroupDropZone>
        )}
        <PaneSplitControl onFocus={onFocus} onSplit={onSplit} />
      </div>
      <div className="relative min-h-0 flex-1" key={activeTab.id}>
        {body}
      </div>
    </div>
  );
}

function UserTabSplitRenderer({
  tab,
  worktreePath,
  paneSessions,
  isActive,
  primaryTabList,
}: {
  tab: UserTab;
  worktreePath: string;
  paneSessions: Record<string, string>;
  isActive: boolean;
  primaryTabList: ReactNode;
}) {
  const tree = getEffectiveUserTabSplitTree(tab);
  const isSplitLayout = getLeaves(tree).length > 1;
  const primaryGroupId = getLeaves(tree)[0]?.id;

  return (
    <SplitTreeRenderer
      tree={tree}
      focusedPaneId={getEffectiveUserTabFocusedPaneId(tab)}
      isActive={isActive}
      onFocusPane={(paneId) => setUserTabFocusedPane(worktreePath, tab.id, paneId)}
      onRatioChange={(splitId, ratio) =>
        updateUserTabRatio(worktreePath, tab.id, splitId, ratio)
      }
      renderLeaf={(group, isFocused) => (
        <PaneTabGroup
          group={group}
          topTabId={tab.id}
          worktreePath={worktreePath}
          paneSessions={paneSessions}
          isActive={isActive}
          isFocused={isFocused}
          isSplitLayout={isSplitLayout}
          isPrimaryGroup={group.id === primaryGroupId}
          primaryTabList={primaryTabList}
          onFocus={() => setUserTabFocusedPane(worktreePath, tab.id, group.id)}
          onSplit={(orientation, content) => {
            setUserTabFocusedPane(worktreePath, tab.id, group.id);
            splitActiveTabPane(worktreePath, orientation, content);
          }}
          onActivate={(groupTabId) =>
            setUserGroupActiveTab(worktreePath, tab.id, group.id, groupTabId)
          }
          onClose={(groupTabId) => {
            setUserGroupActiveTab(worktreePath, tab.id, group.id, groupTabId);
            closeUserTabFocusedPane(worktreePath, tab.id);
          }}
        />
      )}
    />
  );
}

function AgentTabSplitRenderer({
  worktreePath,
  paneSessions,
  isActive,
  primaryTabList,
}: {
  worktreePath: string;
  paneSessions: Record<string, string>;
  isActive: boolean;
  primaryTabList: ReactNode;
}) {
  const splitTree = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.agentTabSplitTree,
  );
  const focusedRaw = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.agentTabFocusedPaneId,
  );
  const tree = useMemo(
    () => getEffectiveAgentTabSplitTree(splitTree),
    [splitTree],
  );
  const focusedPaneId = getEffectiveAgentTabFocusedPaneId(splitTree, focusedRaw);
  const isSplitLayout = getLeaves(tree).length > 1;
  const primaryGroupId = getLeaves(tree)[0]?.id;

  return (
    <SplitTreeRenderer
      tree={tree}
      focusedPaneId={focusedPaneId}
      isActive={isActive}
      onFocusPane={(paneId) => setAgentTabFocusedPane(worktreePath, paneId)}
      onRatioChange={(splitId, ratio) =>
        updateAgentTabRatio(worktreePath, splitId, ratio)
      }
      renderLeaf={(group, isFocused) => (
        <PaneTabGroup
          group={group}
          topTabId={AGENT_PANE_ID}
          worktreePath={worktreePath}
          paneSessions={paneSessions}
          isActive={isActive}
          isFocused={isFocused}
          isSplitLayout={isSplitLayout}
          isPrimaryGroup={group.id === primaryGroupId}
          primaryTabList={primaryTabList}
          onFocus={() => setAgentTabFocusedPane(worktreePath, group.id)}
          onSplit={(orientation, content) => {
            setAgentTabFocusedPane(worktreePath, group.id);
            splitActiveTabPane(worktreePath, orientation, content);
          }}
          onActivate={(groupTabId) =>
            setAgentGroupActiveTab(worktreePath, group.id, groupTabId)
          }
          onClose={(groupTabId) => {
            setAgentGroupActiveTab(worktreePath, group.id, groupTabId);
            closeAgentTabFocusedPane(worktreePath);
          }}
        />
      )}
    />
  );
}

function TopLevelDropZone({
  appendIndex,
  children,
}: {
  appendIndex: number;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: "top-level-strip",
    data: { dropTarget: { type: "top-level", index: appendIndex } },
  });
  return (
    <div
      ref={setNodeRef}
      className={`flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto rounded ${
        isOver ? "ring-1 ring-primary/50" : ""
      }`}
      role="tablist"
      aria-label="Left pane tabs"
    >
      {children}
    </div>
  );
}

function PaneGroupDropZone({
  ownerTopTabId,
  groupId,
  appendIndex,
  children,
}: {
  ownerTopTabId: string;
  groupId: string;
  appendIndex: number;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `group-strip:${ownerTopTabId}:${groupId}`,
    data: {
      dropTarget: {
        type: "group",
        ownerTopTabId,
        groupId,
        index: appendIndex,
      },
    },
  });
  return (
    <div
      ref={setNodeRef}
      className={`flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto rounded ${
        isOver ? "ring-1 ring-primary/50" : ""
      }`}
      role="tablist"
      aria-label="Pane tabs"
    >
      {children}
    </div>
  );
}

function SortableWorkspaceTab({
  dndId,
  disabled,
  className,
  dragData,
  dropTarget,
  children,
}: {
  dndId: string;
  disabled: boolean;
  className: string;
  dragData: WorkspaceTabDragData;
  dropTarget: WorkspaceTabDropTarget;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } =
    useSortable({
      id: dndId,
      disabled,
      data: { ...dragData, dropTarget },
    });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={className}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        disabled={disabled}
        className={`ml-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${
          disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"
        }`}
        aria-label={`Drag ${dragData.label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" className="size-3.5" />
      </button>
      {children}
    </div>
  );
}

function WorkspaceTabDragPreview({
  label,
  kind,
}: {
  label: string;
  kind: TabKind;
}) {
  const Icon =
    kind === "agent"
      ? Bot
      : kind === "file"
        ? FileText
        : kind === "browser"
          ? Globe2
          : Terminal;
  return (
    <div className="flex h-9 max-w-[280px] items-center gap-2.5 rounded-md border border-border bg-accent px-3 text-[0.9375rem] font-medium text-foreground shadow-lg">
      <Icon aria-hidden="true" className="size-4 shrink-0 opacity-90" />
      <span className="truncate">{label}</span>
    </div>
  );
}
