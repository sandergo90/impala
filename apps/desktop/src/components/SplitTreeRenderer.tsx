import { useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { XtermTerminal, releaseCachedTerminal } from "./XtermTerminal";
import type { SplitNode, WorktreeIssue } from "../types";
import { paneSessionId } from "../lib/split-tree";
import { getHookPort } from "../lib/get-hook-port";
import { useUIStore, useDataStore } from "../store";

interface SplitTreeRendererProps {
  tree: SplitNode;
  worktreePath: string;
  focusedPaneId: string;
  /** Map of paneId -> ptySessionId for active sessions */
  paneSessions: Record<string, string>;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
  /** Override cwd for PTY spawn (used by generic terminal) */
  cwd?: string;
  /** When true, skip worktree-specific behavior (Linear context, env vars, Claude auto-launch) */
  isGenericTerminal?: boolean;
}

export function SplitTreeRenderer({
  tree,
  worktreePath,
  focusedPaneId,
  paneSessions,
  onFocusPane,
  onSessionSpawned,
  cwd,
  isGenericTerminal,
}: SplitTreeRendererProps) {
  return (
    <SplitNodeRenderer
      node={tree}
      worktreePath={worktreePath}
      focusedPaneId={focusedPaneId}
      paneSessions={paneSessions}
      onFocusPane={onFocusPane}
      onSessionSpawned={onSessionSpawned}
      cwd={cwd}
      isGenericTerminal={isGenericTerminal}
    />
  );
}

function SplitNodeRenderer({
  node,
  worktreePath,
  focusedPaneId,
  paneSessions,
  onFocusPane,
  onSessionSpawned,
  cwd,
  isGenericTerminal,
}: {
  node: SplitNode;
  worktreePath: string;
  focusedPaneId: string;
  paneSessions: Record<string, string>;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
  cwd?: string;
  isGenericTerminal?: boolean;
}) {
  if (node.type === "leaf") {
    return (
      <LeafPane
        paneId={node.id}
        paneType={node.paneType}
        worktreePath={worktreePath}
        isFocused={node.id === focusedPaneId}
        sessionId={paneSessions[node.id] ?? null}
        onFocus={() => onFocusPane(node.id)}
        onSessionSpawned={(sessionId) => onSessionSpawned(node.id, sessionId)}
        cwd={cwd}
        isGenericTerminal={isGenericTerminal}
      />
    );
  }

  // Split node — render nested ResizablePanelGroup
  // orientation "vertical" in our model = vertical divider = side-by-side = horizontal panel group
  // orientation "horizontal" in our model = horizontal divider = stacked = vertical panel group
  const panelOrientation =
    node.orientation === "vertical" ? "horizontal" : "vertical";

  const firstPercent = Math.round(node.ratio * 100);
  const secondPercent = 100 - firstPercent;

  return (
    <ResizablePanelGroup orientation={panelOrientation}>
      <ResizablePanel defaultSize={`${firstPercent}%`} minSize={80}>
        <SplitNodeRenderer
          node={node.first}
          worktreePath={worktreePath}
          focusedPaneId={focusedPaneId}
          paneSessions={paneSessions}
          onFocusPane={onFocusPane}
          onSessionSpawned={onSessionSpawned}
          cwd={cwd}
          isGenericTerminal={isGenericTerminal}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={`${secondPercent}%`} minSize={80}>
        <SplitNodeRenderer
          node={node.second}
          worktreePath={worktreePath}
          focusedPaneId={focusedPaneId}
          paneSessions={paneSessions}
          onFocusPane={onFocusPane}
          onSessionSpawned={onSessionSpawned}
          cwd={cwd}
          isGenericTerminal={isGenericTerminal}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function LeafPane({
  paneId,
  paneType,
  worktreePath,
  isFocused,
  sessionId,
  onFocus,
  onSessionSpawned,
  cwd,
  isGenericTerminal,
}: {
  paneId: string;
  paneType: "claude" | "shell";
  worktreePath: string;
  isFocused: boolean;
  sessionId: string | null;
  onFocus: () => void;
  onSessionSpawned: (sessionId: string) => void;
  cwd?: string;
  isGenericTerminal?: boolean;
}) {
  const handleRestart = useCallback(() => {
    if (!sessionId) return;
    invoke("pty_kill", { sessionId }).catch(() => {});
    releaseCachedTerminal(sessionId);
    if (isGenericTerminal) {
      const { [paneId]: _, ...remaining } = useDataStore.getState().generalTerminalPaneSessions;
      useDataStore.getState().setGeneralTerminalPaneSessions(remaining);
    } else {
      const data = useDataStore.getState().getWorktreeDataState(worktreePath);
      const { [paneId]: _, ...remaining } = data.paneSessions;
      useDataStore.getState().updateWorktreeDataState(worktreePath, { paneSessions: remaining });
    }
  }, [sessionId, paneId, worktreePath, isGenericTerminal]);

  // Auto-spawn PTY session when leaf has no session
  const spawningRef = useRef(false);
  const spawnCwd = cwd ?? worktreePath;
  useEffect(() => {
    if (sessionId || spawningRef.current) return;
    spawningRef.current = true;

    if (!isGenericTerminal) {
      // Best-effort refresh of Linear context for Claude
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

    const ptyId = paneSessionId(paneId);

    if (isGenericTerminal) {
      // Generic terminal: no worktree-specific env vars, no Claude auto-launch
      invoke<boolean>("pty_spawn", {
        sessionId: ptyId,
        cwd: spawnCwd,
        command: null,
        envVars: {},
      })
        .then(() => {
          onSessionSpawned(ptyId);
        })
        .catch((err) => {
          console.error("Failed to spawn PTY:", err);
          spawningRef.current = false;
        });
    } else {
      getHookPort().then((hookPort) => {
        invoke<boolean>("pty_spawn", {
          sessionId: ptyId,
          cwd: spawnCwd,
          command: null,
          envVars: {
            IMPALA_HOOK_PORT: String(hookPort),
            IMPALA_WORKTREE_PATH: worktreePath,
          },
        })
          .then((isNew) => {
            onSessionSpawned(ptyId);
            if (paneType === "claude" && isNew) {
              const claudeLaunched = useUIStore.getState().getWorktreeNavState(worktreePath).claudeLaunched;

              // Fetch per-project flags, fall back to global
              const projectPath = useUIStore.getState().selectedProject?.path ?? worktreePath;
              Promise.all([
                invoke<string | null>("get_setting", { key: "claudeFlags", scope: projectPath }),
                invoke<string | null>("get_setting", { key: "claudeFlags", scope: "global" }),
              ]).then(([projectFlags, globalFlags]) => {
                const flags = projectFlags ?? globalFlags ?? "";
                const parts = ["claude"];
                if (flags.trim()) parts.push(flags.trim());
                if (claudeLaunched) parts.push("--continue");
                const claudeCmd = parts.join(" ") + "\n";

                const encoded = btoa(
                  Array.from(new TextEncoder().encode(claudeCmd), (b) =>
                    String.fromCharCode(b)
                  ).join("")
                );
                invoke("pty_write", { sessionId: ptyId, data: encoded }).catch(() => {});
              }).catch(() => {});

              useUIStore.getState().updateWorktreeNavState(worktreePath, { claudeLaunched: true });
            }
          })
          .catch((err) => {
            console.error("Failed to spawn PTY:", err);
            spawningRef.current = false;
          });
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onSessionSpawned excluded: backend deduplicates spawns
  }, [paneId, paneType, worktreePath, sessionId, isGenericTerminal, spawnCwd]);

  return (
    <div
      className="h-full w-full relative"
      style={{
        opacity: isFocused ? 1 : 0.6,
        transition: "opacity 150ms ease",
      }}
    >
      {/* Focus indicator border */}
      {isFocused && (
        <div
          className="absolute inset-0 pointer-events-none z-10"
          style={{
            boxShadow: "inset 0 0 0 1px var(--accent)",
            borderRadius: "2px",
          }}
        />
      )}
      {paneType === "claude" && (
        <div className="absolute top-1 right-2 text-md font-medium text-muted-foreground/40 z-10 pointer-events-none">
          Claude
        </div>
      )}
      {sessionId ? (
        <XtermTerminal
          key={sessionId}
          sessionId={sessionId}
          baseDir={worktreePath}
          isFocused={isFocused}
          onFocus={onFocus}
          onRestart={handleRestart}
        />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Starting terminal...
        </div>
      )}
    </div>
  );
}
