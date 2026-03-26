import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { GhosttyTerminal } from "./GhosttyTerminal";
import type { SplitNode } from "../types";
import { paneSessionId } from "../lib/split-tree";
import { useUIStore } from "../store";

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
  // Auto-spawn PTY session when leaf has no session
  // Backend deduplicates via sessions.contains_key — safe to call multiple times
  useEffect(() => {
    if (sessionId) return;

    const ptyId = paneSessionId(paneId);
    let command: string[] | null = null;
    if (paneType === "claude") {
      const claudeLaunched = useUIStore.getState().getWorktreeNavState(worktreePath).claudeLaunched;
      command = claudeLaunched
        ? ["claude", "--dangerously-skip-permissions", "--continue"]
        : ["claude", "--dangerously-skip-permissions"];
    }

    invoke("pty_spawn", {
      sessionId: ptyId,
      cwd: worktreePath,
      command,
    })
      .then(() => {
        onSessionSpawned(ptyId);
        if (paneType === "claude") {
          useUIStore.getState().updateWorktreeNavState(worktreePath, { claudeLaunched: true });
        }
      })
      .catch((err) => console.error("Failed to spawn PTY:", err));
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
        <GhosttyTerminal
          key={sessionId}
          sessionId={sessionId}
          onFocus={onFocus}
        />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Starting terminal...
        </div>
      )}
    </div>
  );
}
