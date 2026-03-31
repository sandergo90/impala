import { useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { XtermTerminal } from "./XtermTerminal";
import type { SplitNode, WorktreeIssue } from "../types";
import { paneSessionId } from "../lib/split-tree";
import { useUIStore, useDataStore } from "../store";

let cachedHookPort: number | null = null;
async function getHookPort(): Promise<number> {
  if (cachedHookPort === null) {
    cachedHookPort = await invoke<number>("get_hook_port");
  }
  return cachedHookPort;
}

interface SplitTreeRendererProps {
  tree: SplitNode;
  worktreePath: string;
  focusedPaneId: string;
  /** Map of paneId -> ptySessionId for active sessions */
  paneSessions: Record<string, string>;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
}

export function SplitTreeRenderer({
  tree,
  worktreePath,
  focusedPaneId,
  paneSessions,
  onFocusPane,
  onSessionSpawned,
}: SplitTreeRendererProps) {
  return (
    <SplitNodeRenderer
      node={tree}
      worktreePath={worktreePath}
      focusedPaneId={focusedPaneId}
      paneSessions={paneSessions}
      onFocusPane={onFocusPane}
      onSessionSpawned={onSessionSpawned}
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
}: {
  node: SplitNode;
  worktreePath: string;
  focusedPaneId: string;
  paneSessions: Record<string, string>;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
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
}: {
  paneId: string;
  paneType: "claude" | "shell";
  worktreePath: string;
  isFocused: boolean;
  sessionId: string | null;
  onFocus: () => void;
  onSessionSpawned: (sessionId: string) => void;
}) {
  const handleRestart = useCallback(() => {
    if (!sessionId) return;
    invoke("pty_kill", { sessionId }).catch(() => {});
    const data = useDataStore.getState().getWorktreeDataState(worktreePath);
    const { [paneId]: _, ...remaining } = data.paneSessions;
    useDataStore.getState().updateWorktreeDataState(worktreePath, { paneSessions: remaining });
  }, [sessionId, paneId, worktreePath]);

  const linearApiKey = useUIStore((s) => s.linearApiKey);

  // Auto-spawn PTY session when leaf has no session
  const spawningRef = useRef(false);
  useEffect(() => {
    if (sessionId || spawningRef.current) return;
    spawningRef.current = true;

    // Best-effort refresh of Linear context for Claude
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

    const ptyId = paneSessionId(paneId);

    getHookPort().then((hookPort) => {
      invoke<boolean>("pty_spawn", {
        sessionId: ptyId,
        cwd: worktreePath,
        command: null,
        envVars: {
          DIFFER_HOOK_PORT: String(hookPort),
          DIFFER_WORKTREE_PATH: worktreePath,
        },
      })
        .then((isNew) => {
          onSessionSpawned(ptyId);
          if (paneType === "claude" && isNew) {
            const claudeLaunched = useUIStore.getState().getWorktreeNavState(worktreePath).claudeLaunched;
            const claudeCmd = claudeLaunched
              ? "claude --dangerously-skip-permissions --remote-control --continue\n"
              : "claude --dangerously-skip-permissions --remote-control\n";
            const encoded = btoa(
              Array.from(new TextEncoder().encode(claudeCmd), (b) =>
                String.fromCharCode(b)
              ).join("")
            );
            invoke("pty_write", { sessionId: ptyId, data: encoded }).catch(() => {});
            useUIStore.getState().updateWorktreeNavState(worktreePath, { claudeLaunched: true });
          }
        })
        .catch((err) => {
          console.error("Failed to spawn PTY:", err);
          spawningRef.current = false;
        });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onSessionSpawned excluded: backend deduplicates spawns
  }, [paneId, paneType, worktreePath, sessionId]);

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
        <div className="absolute top-1 right-2 text-[9px] font-medium text-muted-foreground/40 z-10 pointer-events-none">
          Claude
        </div>
      )}
      {sessionId ? (
        <XtermTerminal
          key={sessionId}
          sessionId={sessionId}
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
