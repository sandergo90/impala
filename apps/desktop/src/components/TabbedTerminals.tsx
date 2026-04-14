import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { XtermTerminal } from "./XtermTerminal";
import { useUIStore, useDataStore } from "../store";
import type { WorktreeIssue } from "../types";

const CLAUDE_PANE_ID = "tab-claude";
const RUN_PANE_ID = "tab-run";

type TabKind = "claude" | "run";

interface ProjectConfig {
  setup?: string | null;
  run?: string | null;
}

async function getHookPort(): Promise<number> {
  try {
    return await invoke<number>("get_hook_port");
  } catch {
    return 0;
  }
}

/**
 * Tabbed terminals view for a single worktree.
 *
 * Renders a Claude tab (always) and a Run tab (when config.setup or config.run is set).
 * When `claudeOnly` is true, the tab strip is hidden and only the Claude body renders —
 * this is the mode used by the top-level Split tab so the Claude pane sits next to the diff.
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
  // Subscribe so re-renders fire when nav state or paneSessions change.
  useUIStore((s) => s.worktreeNavStates[worktreePath]);
  const dataState = useDataStore((s) => s.worktreeDataStates[worktreePath]);
  const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
  const paneSessions = dataState?.paneSessions ?? {};

  // Read project config once per worktree. The Run tab's existence depends on it.
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

  const tabs: { kind: TabKind; label: string; paneId: string }[] = [
    { kind: "claude", label: "Claude", paneId: CLAUDE_PANE_ID },
  ];
  if (hasRunTab) {
    tabs.push({ kind: "run", label: "Run", paneId: RUN_PANE_ID });
  }

  // If the active tab no longer exists (e.g. config removed run script), fall back to claude.
  const activeKind: TabKind = tabs.some((t) => t.kind === nav.activeTerminalsTab)
    ? nav.activeTerminalsTab
    : "claude";

  const setActive = useCallback(
    (kind: TabKind) => {
      useUIStore
        .getState()
        .updateWorktreeNavState(worktreePath, { activeTerminalsTab: kind });
    },
    [worktreePath],
  );

  // claudeOnly: render just the Claude body, no tab strip. Used by the Split top-tab.
  if (claudeOnly) {
    return (
      <div className="relative h-full w-full">
        <TabBody
          paneId={CLAUDE_PANE_ID}
          paneKind="claude"
          worktreePath={worktreePath}
          sessionId={paneSessions[CLAUDE_PANE_ID] ?? null}
          isVisible
          isActive={isActive}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-0.5 px-2 pt-1 border-b border-border/40">
        {tabs.map((t) => (
          <button
            key={t.kind}
            onClick={() => setActive(t.kind)}
            className={`px-3 py-1 text-md font-medium rounded-t transition-colors ${
              activeKind === t.kind
                ? "text-foreground bg-accent"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab bodies — all mounted, hidden via z-index/visibility */}
      <div className="relative flex-1 min-h-0">
        {tabs.map((t) => {
          const visible = activeKind === t.kind;
          return (
            <div
              key={t.kind}
              className="absolute inset-0"
              style={{
                visibility: visible ? "visible" : "hidden",
                zIndex: visible ? 1 : 0,
                pointerEvents: visible ? "auto" : "none",
              }}
            >
              <TabBody
                paneId={t.paneId}
                paneKind={t.kind}
                worktreePath={worktreePath}
                sessionId={paneSessions[t.paneId] ?? null}
                isVisible={visible}
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
 * Renders one tab body. Lazy-spawns the PTY the first time it mounts with no session.
 * For the Claude tab, also runs the Claude auto-launch flow on first spawn.
 */
function TabBody({
  paneId,
  paneKind,
  worktreePath,
  sessionId,
  isActive,
}: {
  paneId: string;
  paneKind: TabKind;
  worktreePath: string;
  sessionId: string | null;
  isVisible: boolean;
  isActive: boolean;
}) {
  const spawningRef = useRef(false);

  useEffect(() => {
    if (sessionId || spawningRef.current) return;
    spawningRef.current = true;

    // Best-effort Linear context refresh for Claude tabs (mirrors SplitTreeRenderer).
    if (paneKind === "claude") {
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
          // Register the session in dataStore so future renders see it.
          const data = useDataStore.getState().getWorktreeDataState(worktreePath);
          useDataStore.getState().updateWorktreeDataState(worktreePath, {
            paneSessions: { ...data.paneSessions, [paneId]: ptyId },
          });

          // Claude auto-launch (mirrors SplitTreeRenderer logic).
          if (paneKind === "claude" && isNew) {
            const claudeLaunched = useUIStore
              .getState()
              .getWorktreeNavState(worktreePath).claudeLaunched;

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
                if (claudeLaunched) parts.push("--continue");
                const claudeCmd = parts.join(" ") + "\n";
                const encoded = btoa(
                  Array.from(new TextEncoder().encode(claudeCmd), (b) =>
                    String.fromCharCode(b),
                  ).join(""),
                );
                invoke("pty_write", { sessionId: ptyId, data: encoded }).catch(
                  () => {},
                );
              })
              .catch(() => {});

            useUIStore
              .getState()
              .updateWorktreeNavState(worktreePath, { claudeLaunched: true });
          }
        })
        .catch((err) => {
          console.error("Failed to spawn PTY:", err);
          spawningRef.current = false;
        });
    });
  }, [paneId, paneKind, worktreePath, sessionId]);

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
