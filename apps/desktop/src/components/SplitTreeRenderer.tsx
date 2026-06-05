import { useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { XtermTerminal, releaseCachedTerminal } from "./XtermTerminal";
import type { SplitNode } from "../types";
import { paneSessionId } from "../lib/split-tree";
import { useDataStore } from "../store";
import { useAppHotkey } from "../hooks/useAppHotkey";

interface SplitTreeRendererProps {
  tree: SplitNode;
  worktreePath: string;
  focusedPaneId: string;
  /** Map of paneId -> ptySessionId for active sessions */
  paneSessions: Record<string, string>;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
  /** Override cwd for PTY spawn */
  cwd?: string;
}

export function SplitTreeRenderer({
  tree,
  worktreePath,
  focusedPaneId,
  paneSessions,
  onFocusPane,
  onSessionSpawned,
  cwd,
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
}: {
  node: SplitNode;
  worktreePath: string;
  focusedPaneId: string;
  paneSessions: Record<string, string>;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
  cwd?: string;
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
}: {
  paneId: string;
  paneType: "agent" | "shell";
  worktreePath: string;
  isFocused: boolean;
  sessionId: string | null;
  onFocus: () => void;
  onSessionSpawned: (sessionId: string) => void;
  cwd?: string;
}) {
  const handleRestart = useCallback(() => {
    if (!sessionId) return;
    invoke("pty_kill", { sessionId }).catch(() => {});
    releaseCachedTerminal(sessionId);
    const { [paneId]: _, ...remaining } =
      useDataStore.getState().generalTerminalPaneSessions;
    useDataStore.getState().setGeneralTerminalPaneSessions(remaining);
  }, [sessionId, paneId]);

  useAppHotkey("RESTART_SESSION", handleRestart, { enabled: isFocused }, [handleRestart]);

  // Auto-spawn PTY session when leaf has no session. This renderer backs the
  // generic terminal only: no worktree env vars and no agent auto-launch.
  const spawningRef = useRef(false);
  const spawnCwd = cwd ?? worktreePath;
  useEffect(() => {
    if (sessionId || spawningRef.current) return;
    spawningRef.current = true;

    const ptyId = paneSessionId(paneId);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onSessionSpawned excluded: backend deduplicates spawns
  }, [paneId, sessionId, spawnCwd]);

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
      {paneType === "agent" && (
        <div className="absolute top-1 right-2 text-md font-medium text-muted-foreground/40 z-10 pointer-events-none">
          Agent
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
