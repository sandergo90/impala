import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { XtermTerminal } from "./XtermTerminal";
import { useUIStore, useDataStore } from "../store";
import type { WorktreeIssue } from "../types";
import { encodePtyInput } from "../lib/encode-pty";
import { getHookPort } from "../lib/get-hook-port";
import {
  CLAUDE_PANE_ID,
  RUN_PANE_ID,
  userTabPaneId,
  runPtySessionId,
} from "../lib/pane-ids";
import { createUserTab, closeUserTab, renameUserTab } from "../lib/tab-actions";

type TabKind = "terminal" | "claude";

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
 * System tabs: Claude (always) and Run (when config.setup or config.run is set).
 * User tabs: from nav.userTabs, created via the plus button.
 *
 * When `claudeOnly` is true, the tab strip + plus button are hidden and only
 * the primary Claude body renders — used by the top-level Split tab so Claude
 * sits next to the diff.
 */
export const TabbedTerminals = memo(function TabbedTerminals({
  worktreePath,
  isActive,
  claudeOnly = false,
}: {
  worktreePath: string;
  isActive: boolean;
  claudeOnly?: boolean;
}) {
  const activeTerminalsTab = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.activeTerminalsTab ?? CLAUDE_PANE_ID,
  );
  const userTabs = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.userTabs ?? [],
  );
  const dataState = useDataStore((s) => s.worktreeDataStates[worktreePath]);
  const paneSessions = dataState?.paneSessions ?? {};
  const runStatus = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.runStatus ?? "idle",
  );
  const runExitCode = useUIStore(
    (s) => s.worktreeNavStates[worktreePath]?.runExitCode ?? null,
  );

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

    const sessionId = runPtySessionId(worktreePath);
    listen<number>(`pty-exit-${sessionId}`, (event) => {
      const code = event.payload;
      useUIStore.getState().updateWorktreeNavState(worktreePath, {
        runStatus: "idle",
        runExitCode: code,
        hasUnreadRunFailure: code !== 0,
      });
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
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
    const out: TabDescriptor[] = [
      {
        id: CLAUDE_PANE_ID,
        label: "Claude",
        kind: "claude",
        useContinueFlag: true,
        paneId: CLAUDE_PANE_ID,
        isSystem: true,
      },
    ];
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

  const activeId: string = tabs.some((t) => t.id === activeTerminalsTab)
    ? activeTerminalsTab
    : CLAUDE_PANE_ID;

  const previousTabIdRef = useRef<string | null>(null);
  const lastSeenActiveRef = useRef<string>(activeId);
  useEffect(() => {
    if (lastSeenActiveRef.current !== activeId) {
      previousTabIdRef.current = lastSeenActiveRef.current;
      lastSeenActiveRef.current = activeId;
    }
  }, [activeId]);

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
    (tabId: string) => {
      const previousActive =
        tabId === activeId ? previousTabIdRef.current : activeId;
      closeUserTab(worktreePath, tabId, { previousActive });
    },
    [worktreePath, activeId],
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");

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

  const handleNewClaude = useCallback(() => {
    setMenuOpen(false);
    createUserTab(worktreePath, "claude");
  }, [worktreePath]);

  if (claudeOnly) {
    return (
      <div className="relative h-full w-full">
        <TabBody
          paneId={CLAUDE_PANE_ID}
          kind="claude"
          useContinueFlag
          worktreePath={worktreePath}
          sessionId={paneSessions[CLAUDE_PANE_ID] ?? null}
          isActive={isActive}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex shrink-0 items-center gap-0.5 px-2 pt-1 border-b border-border/40">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center ${
              activeId === t.id
                ? "text-foreground bg-accent"
                : "text-muted-foreground hover:text-foreground"
            } rounded-t`}
          >
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
                className="mx-3 my-1 w-24 bg-background border border-border rounded px-1 text-md font-medium outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <button
                onClick={() => setActive(t.id)}
                onDoubleClick={() => {
                  if (!t.isSystem) startRenaming(t.id, t.label);
                }}
                className="px-3 py-1 text-md font-medium transition-colors flex items-center gap-1.5"
              >
                {t.label}
                {t.id === RUN_PANE_ID && (
                  <RunStatusDot status={runStatus} exitCode={runExitCode} />
                )}
              </button>
            )}
            {!t.isSystem && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseUserTab(t.id);
                }}
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
          </div>
        ))}

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
                onClick={handleNewClaude}
                className="block w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
              >
                New Claude tab
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        {tabs.map((t) => {
          const visible = activeId === t.id;
          return (
            <div
              key={t.id}
              className="absolute inset-0"
              style={{
                visibility: visible ? "visible" : "hidden",
                zIndex: visible ? 1 : 0,
                pointerEvents: visible ? "auto" : "none",
              }}
            >
              <TabBody
                paneId={t.paneId}
                kind={t.kind}
                useContinueFlag={t.useContinueFlag}
                worktreePath={worktreePath}
                sessionId={paneSessions[t.paneId] ?? null}
                isActive={isActive && visible}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

/**
 * Renders one tab body. Lazy-spawns the PTY on first mount.
 * Claude tabs additionally write the `claude` command on first spawn.
 * `useContinueFlag` controls whether the primary Claude tab appends `--continue`.
 */
function TabBody({
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

    if (kind === "claude" && useContinueFlag) {
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

    getHookPort().then((hookPort) => {
      invoke<boolean>("pty_spawn", {
        sessionId: ptyId,
        cwd: worktreePath,
        command: null,
        envVars: {
          IMPALA_HOOK_PORT: String(hookPort),
          IMPALA_WORKTREE_PATH: worktreePath,
        },
      })
        .then((isNew) => {
          const data = useDataStore.getState().getWorktreeDataState(worktreePath);
          useDataStore.getState().updateWorktreeDataState(worktreePath, {
            paneSessions: { ...data.paneSessions, [paneId]: ptyId },
          });

          if (kind === "claude" && isNew) {
            const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
            const claudeLaunched = nav.claudeLaunched;

            const projectPath =
              useUIStore.getState().selectedProject?.path ?? worktreePath;
            Promise.all([
              invoke<string | null>("get_setting", {
                key: "claudeFlags",
                scope: projectPath,
              }),
              invoke<string | null>("get_setting", {
                key: "claudeFlags",
                scope: "global",
              }),
            ])
              .then(([projectFlags, globalFlags]) => {
                const flags = projectFlags ?? globalFlags ?? "";
                const parts = ["claude"];
                if (flags.trim()) parts.push(flags.trim());
                if (useContinueFlag && claudeLaunched) parts.push("--continue");
                const encoded = encodePtyInput(parts.join(" ") + "\n");
                invoke("pty_write", { sessionId: ptyId, data: encoded }).catch(
                  () => {},
                );
              })
              .catch(() => {});

            if (useContinueFlag && !claudeLaunched) {
              useUIStore
                .getState()
                .updateWorktreeNavState(worktreePath, { claudeLaunched: true });
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
    const data = useDataStore.getState().getWorktreeDataState(worktreePath);
    const { [paneId]: _removed, ...remaining } = data.paneSessions;
    useDataStore
      .getState()
      .updateWorktreeDataState(worktreePath, { paneSessions: remaining });
  }, [sessionId, paneId, worktreePath]);

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
}

function RunStatusDot({
  status,
  exitCode,
}: {
  status: "idle" | "running" | "stopping";
  exitCode: number | null;
}) {
  if (status === "running" || status === "stopping") {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full border-[1.5px] border-blue-400 border-t-transparent animate-spin"
        aria-label="Running"
      />
    );
  }
  if (exitCode !== null && exitCode !== 0) {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-red-500"
        aria-label="Failed"
      />
    );
  }
  return null;
}
