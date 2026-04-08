import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Outlet, useRouter, useMatchRoute } from "@tanstack/react-router";
import { useInvoke } from "./hooks/useInvoke";
import { CommandPalette } from "./components/CommandPalette";
import { FloatingTerminal } from "./components/FloatingTerminal";
import { Toaster } from "./components/ui/sonner";
import { useUIStore, useDataStore } from "./store";
import {
  splitNode,
  removeNode,
  getAdjacentLeafId,
  getLeaves,
} from "./lib/split-tree";
import { triggerRunScript } from "./lib/run-script";
import { useHotkeysStore } from "./stores/hotkeys";

export function RootLayout() {
  const { loading: checking, error: gitError } = useInvoke("check_git");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const router = useRouter();
  const matchRoute = useMatchRoute();

  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path;

  useEffect(() => {
    useHotkeysStore.getState().load();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+, → toggle settings
      if (e.metaKey && e.key === ",") {
        e.preventDefault();
        const isSettings = matchRoute({
          to: "/settings",
          fuzzy: true,
        });
        router.navigate({
          to: isSettings ? "/" : "/settings/appearance",
        });
        return;
      }

      // Cmd+P → command palette
      if (e.metaKey && e.key === "p") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }

      // Cmd+Shift+R → run script
      if (e.metaKey && e.shiftKey && (e.key === "R" || e.key === "r")) {
        e.preventDefault();
        triggerRunScript();
        return;
      }

      // Split keybindings apply when terminal or split tab is active
      if (!wtPath) return;
      const nav = useUIStore.getState().getWorktreeNavState(wtPath);
      if (nav.activeTab !== "terminal" && nav.activeTab !== "split") return;

      const focusedId = nav.focusedPaneId;
      const tree = nav.splitTree;

      // Cmd+D → split vertical
      if (e.metaKey && !e.shiftKey && e.key === "d") {
        e.preventDefault();
        if (nav.activeTab === "split") return;
        const result = splitNode(tree, focusedId, "vertical");
        if (result) {
          useUIStore.getState().updateWorktreeNavState(wtPath, {
            splitTree: result.tree,
            focusedPaneId: result.newLeafId,
          });
        }
        return;
      }

      // Cmd+Shift+D → split horizontal
      if (e.metaKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        if (nav.activeTab === "split") return;
        const result = splitNode(tree, focusedId, "horizontal");
        if (result) {
          useUIStore.getState().updateWorktreeNavState(wtPath, {
            splitTree: result.tree,
            focusedPaneId: result.newLeafId,
          });
        }
        return;
      }

      // Cmd+] → next pane
      if (e.metaKey && e.key === "]") {
        e.preventDefault();
        const nextId = getAdjacentLeafId(tree, focusedId, 1);
        useUIStore
          .getState()
          .updateWorktreeNavState(wtPath, { focusedPaneId: nextId });
        return;
      }

      // Cmd+[ → previous pane
      if (e.metaKey && e.key === "[") {
        e.preventDefault();
        const prevId = getAdjacentLeafId(tree, focusedId, -1);
        useUIStore
          .getState()
          .updateWorktreeNavState(wtPath, { focusedPaneId: prevId });
        return;
      }

      // Cmd+W → close focused pane (don't close last)
      if (e.metaKey && e.key === "w") {
        e.preventDefault();
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
        useUIStore.getState().updateWorktreeNavState(wtPath, {
          splitTree: newTree,
          focusedPaneId: newFocusId,
        });
        return;
      }
    };
    // Capture phase so split keybindings fire before the terminal consumes them
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [wtPath, router, matchRoute]);

  if (checking) return null;

  if (gitError) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center">
          <h2 className="text-lg font-semibold mb-2">Git Not Found</h2>
          <p className="text-muted-foreground">
            Please install Git to use Canopy.
          </p>
          <p className="text-muted-foreground text-xs mt-2">
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
    </div>
  );
}

export default RootLayout;
