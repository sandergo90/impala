import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Outlet, useRouter, useMatchRoute } from "@tanstack/react-router";
import { useInvoke } from "./hooks/useInvoke";
import { useAppHotkey } from "./hooks/useAppHotkey";
import { CommandPalette } from "./components/CommandPalette";
import { FloatingTerminal } from "./components/FloatingTerminal";
import { Toaster } from "./components/ui/sonner";
import { UpdateChecker } from "./components/UpdateChecker";
import { useUIStore, useDataStore } from "./store";
import {
  splitNode,
  removeNode,
  getAdjacentLeafId,
  getLeaves,
} from "./lib/split-tree";
import { toggleRunScript } from "./lib/run-script";
import { useHotkeysStore } from "./stores/hotkeys";
import { selectWorktree } from "./hooks/useWorktreeActions";

export function RootLayout() {
  const { loading: checking, error: gitError } = useInvoke("check_git");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const router = useRouter();
  const matchRoute = useMatchRoute();

  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path;

  const activeTab = useUIStore((s) =>
    wtPath ? s.getWorktreeNavState(wtPath).activeTab : null,
  );
  const isTerminalTab = activeTab === "terminal" || activeTab === "split";

  useEffect(() => {
    useHotkeysStore.getState().load();

    // Load linearApiKey from backend, migrate from localStorage if needed
    (async () => {
      try {
        const backendKey = await invoke<string | null>("get_setting", { key: "linearApiKey", scope: "global" });
        if (backendKey) {
          useUIStore.getState().setLinearApiKey(backendKey);
        } else {
          // One-time migration: check if localStorage has the key
          const localKey = useUIStore.getState().linearApiKey;
          if (localKey) {
            await invoke("set_setting", { key: "linearApiKey", scope: "global", value: localKey });
          }
        }
      } catch {
        // Backend unavailable — fall back to whatever Zustand has
      }
    })();
  }, []);

  // -- Navigation shortcuts (always active) --

  useAppHotkey("OPEN_SETTINGS", () => {
    const isSettings = matchRoute({ to: "/settings", fuzzy: true });
    router.navigate({ to: isSettings ? "/" : "/settings/appearance" });
  });

  useAppHotkey("OPEN_COMMAND_PALETTE", () => {
    setCommandPaletteOpen((prev) => !prev);
  });

  useAppHotkey("RUN_SCRIPT", () => {
    toggleRunScript();
  });

  useAppHotkey("SHOW_KEYBOARD_SHORTCUTS", () => {
    router.navigate({ to: "/settings/keyboard" });
  }, undefined, [router]);

  // -- Terminal / split pane shortcuts (only when terminal or split tab is active) --

  const generalTerminalActive = useUIStore((s) => s.generalTerminalActive);

  const handleSplit = (direction: "vertical" | "horizontal") => {
    const uiState = useUIStore.getState();
    if (uiState.generalTerminalActive) {
      const result = splitNode(uiState.generalTerminalSplitTree, uiState.generalTerminalFocusedPaneId, direction);
      if (result) {
        uiState.setGeneralTerminalSplitTree(result.tree);
        uiState.setGeneralTerminalFocusedPaneId(result.newLeafId);
      }
    } else if (wtPath) {
      const nav = uiState.getWorktreeNavState(wtPath);
      if (nav.activeTab === "split") return;
      const result = splitNode(nav.splitTree, nav.focusedPaneId, direction);
      if (result) {
        uiState.updateWorktreeNavState(wtPath, {
          splitTree: result.tree,
          focusedPaneId: result.newLeafId,
        });
      }
    }
  };

  const handleFocusAdjacentPane = (direction: 1 | -1) => {
    const uiState = useUIStore.getState();
    if (uiState.generalTerminalActive) {
      const targetId = getAdjacentLeafId(uiState.generalTerminalSplitTree, uiState.generalTerminalFocusedPaneId, direction);
      uiState.setGeneralTerminalFocusedPaneId(targetId);
    } else if (wtPath) {
      const nav = uiState.getWorktreeNavState(wtPath);
      const targetId = getAdjacentLeafId(nav.splitTree, nav.focusedPaneId, direction);
      uiState.updateWorktreeNavState(wtPath, { focusedPaneId: targetId });
    }
  };

  useAppHotkey("SPLIT_VERTICAL", () => handleSplit("vertical"), { enabled: isTerminalTab || generalTerminalActive }, [wtPath, generalTerminalActive]);
  useAppHotkey("SPLIT_HORIZONTAL", () => handleSplit("horizontal"), { enabled: isTerminalTab || generalTerminalActive }, [wtPath, generalTerminalActive]);
  useAppHotkey("NEXT_PANE", () => handleFocusAdjacentPane(1), { enabled: isTerminalTab || generalTerminalActive }, [wtPath, generalTerminalActive]);
  useAppHotkey("PREV_PANE", () => handleFocusAdjacentPane(-1), { enabled: isTerminalTab || generalTerminalActive }, [wtPath, generalTerminalActive]);

  useAppHotkey(
    "CLOSE_PANE",
    () => {
      const uiState = useUIStore.getState();
      if (uiState.generalTerminalActive) {
        const { generalTerminalSplitTree: tree, generalTerminalFocusedPaneId: focusedId } = uiState;
        const leaves = getLeaves(tree);
        if (leaves.length <= 1) return;

        const adjacentId = getAdjacentLeafId(tree, focusedId, -1);
        const newTree = removeNode(tree, focusedId);
        if (!newTree) return;

        // Kill the PTY session for the closed pane
        const sessionId = useDataStore.getState().generalTerminalPaneSessions[focusedId];
        if (sessionId) {
          invoke("pty_kill", { sessionId }).catch(() => {});
          const { [focusedId]: _, ...remaining } = useDataStore.getState().generalTerminalPaneSessions;
          useDataStore.getState().setGeneralTerminalPaneSessions(remaining);
        }

        const newLeaves = getLeaves(newTree);
        const newLeafIds = new Set(newLeaves.map((l) => l.id));
        const newFocusId = newLeafIds.has(adjacentId)
          ? adjacentId
          : newLeaves[0]?.id ?? "default";
        uiState.setGeneralTerminalSplitTree(newTree);
        uiState.setGeneralTerminalFocusedPaneId(newFocusId);
      } else if (wtPath) {
        const nav = uiState.getWorktreeNavState(wtPath);
        const { focusedPaneId: focusedId, splitTree: tree } = nav;
        const leaves = getLeaves(tree);
        if (leaves.length <= 1) return; // don't close last pane

        // Don't close Claude panes
        const focusedLeaf = leaves.find((l) => l.id === focusedId);
        if (focusedLeaf?.paneType === "claude") return;

        // Determine adjacent pane BEFORE removing, so we know the neighbor
        const adjacentId = getAdjacentLeafId(tree, focusedId, -1);

        const newTree = removeNode(tree, focusedId);
        if (!newTree) return;

        // Kill the PTY session for the closed pane
        const data = useDataStore.getState().getWorktreeDataState(wtPath);
        const sessionId = data.paneSessions[focusedId];
        if (sessionId) {
          invoke("pty_kill", { sessionId }).catch(() => {});
          const { [focusedId]: _, ...remaining } = data.paneSessions;
          useDataStore
            .getState()
            .updateWorktreeDataState(wtPath, { paneSessions: remaining });
        }

        // Focus adjacent pane (fall back to first leaf if adjacent was the one removed)
        const newLeaves = getLeaves(newTree);
        const newLeafIds = new Set(newLeaves.map((l) => l.id));
        const newFocusId = newLeafIds.has(adjacentId)
          ? adjacentId
          : newLeaves[0]?.id ?? "default";
        uiState.updateWorktreeNavState(wtPath, {
          splitTree: newTree,
          focusedPaneId: newFocusId,
        });
      }
    },
    { enabled: isTerminalTab || generalTerminalActive },
    [wtPath, generalTerminalActive],
  );

  // -- Worktree jump shortcuts (always active) --
  const worktrees = useDataStore((s) => s.worktrees);
  const jumpTo = (index: number) => {
    if (worktrees[index]) selectWorktree(worktrees[index]);
  };

  useAppHotkey("JUMP_TO_WORKTREE_1", () => jumpTo(0));
  useAppHotkey("JUMP_TO_WORKTREE_2", () => jumpTo(1));
  useAppHotkey("JUMP_TO_WORKTREE_3", () => jumpTo(2));
  useAppHotkey("JUMP_TO_WORKTREE_4", () => jumpTo(3));
  useAppHotkey("JUMP_TO_WORKTREE_5", () => jumpTo(4));
  useAppHotkey("JUMP_TO_WORKTREE_6", () => jumpTo(5));
  useAppHotkey("JUMP_TO_WORKTREE_7", () => jumpTo(6));
  useAppHotkey("JUMP_TO_WORKTREE_8", () => jumpTo(7));
  useAppHotkey("JUMP_TO_WORKTREE_9", () => jumpTo(8));

  if (checking) return null;

  if (gitError) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center">
          <h2 className="text-lg font-semibold mb-2">Git Not Found</h2>
          <p className="text-muted-foreground">
            Please install Git to use Impala.
          </p>
          <p className="text-muted-foreground text-md mt-2">
            https://git-scm.com/download
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col">
      <Outlet />
      <FloatingTerminal />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
      <Toaster />
      <UpdateChecker />
    </div>
  );
}

export default RootLayout;
