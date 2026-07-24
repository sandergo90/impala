import { useEffect } from "react";
import { invoke } from "@/lib/invoke";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Outlet, useRouter, useMatchRoute } from "@tanstack/react-router";
import { useInvoke } from "./hooks/useInvoke";
import { useAppHotkey } from "./hooks/useAppHotkey";
import { CommandPalette } from "./components/CommandPalette";
import { FileFinder } from "./components/FileFinder";
import { Toaster } from "./components/ui/sonner";
import { UpdateChecker } from "./components/UpdateChecker";
import { useAgentNotifications } from "./hooks/useAgentNotifications";
import { useAgentStatusSync } from "./hooks/useAgentStatusSync";
import { useDockBadge } from "./hooks/useDockBadge";
import { useBrowserUnderlayBridge } from "./hooks/useBrowserUnderlayBridge";
import { useUIStore, useDataStore, useFilteredWorktrees } from "./store";
import {
  splitNode,
  removeNode,
  getAdjacentLeafId,
  getLeaves,
} from "./lib/split-tree";
import { toggleRunScript } from "./lib/run-script";
import { startAutomationExecutor } from "./lib/automation-executor";
import { useHotkeysStore } from "./stores/hotkeys";
import { selectWorktree, selectProject } from "./hooks/useWorktreeActions";
import {
  closeUserTabFocusedPane,
  focusAdjacentUserTabPane,
  closeAgentTabFocusedPane,
  focusAdjacentAgentTabPane,
  createBrowserTab,
  createAgentTabFromRequest,
  canSplitTerminalsTab,
  splitActiveTabPane,
} from "./lib/tab-actions";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AGENT_PANE_ID, RUN_PANE_ID } from "./lib/pane-ids";
import { releaseCachedTerminal } from "./components/XtermTerminal";

export function RootLayout() {
  const { loading: checking, error: gitError } = useInvoke("check_git");
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const fileFinderOpen = useUIStore((s) => s.fileFinderOpen);
  const setFileFinderOpen = useUIStore((s) => s.setFileFinderOpen);
  const browserUnderlayEnabled = useUIStore(
    (s) => s.browserUnderlayEnabled,
  );

  const router = useRouter();
  const matchRoute = useMatchRoute();

  useAgentStatusSync();
  useAgentNotifications();
  useDockBadge();
  useBrowserUnderlayBridge();

  // Agent browser interactions (hook-server /browser/*): create the tab on a
  // navigate for a worktree without one, and mark activity for the indicators.
  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let cancelled = false;
    const track = (p: Promise<UnlistenFn>) => {
      p.then((fn) => {
        if (cancelled) fn();
        else unlistens.push(fn);
      }).catch(() => {});
    };
    track(
      listen<{ worktreePath: string; url: string }>(
        "browser-request-open",
        (event) => {
          createBrowserTab(event.payload.worktreePath, event.payload.url);
        },
      ),
    );
    track(
      listen<{ worktreePath: string; kind: string }>(
        "browser-agent-activity",
        (event) => {
          useUIStore
            .getState()
            .markBrowserAgentActivity(
              event.payload.worktreePath,
              event.payload.kind,
            );
        },
      ),
    );
    track(
      listen<{
        worktreePath: string;
        prompt: string;
        agent?: "claude" | "codex";
        sourcePaneId?: string;
        placement?: "auto" | "current" | "left" | "right";
      }>(
        "agent-tab-request-open",
        (event) => {
          createAgentTabFromRequest(
            event.payload.worktreePath,
            event.payload.prompt,
            event.payload.agent,
            event.payload.sourcePaneId,
            event.payload.placement,
          );
        },
      ),
    );
    return () => {
      cancelled = true;
      for (const fn of unlistens) fn();
    };
  }, []);

  // Scheduled automations: the Rust scheduler emits automation-due; the
  // executor creates the worktree and launches the agent.
  useEffect(() => startAutomationExecutor(), []);

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

    // Mirror the DB-backed worktree base dir into the UI store so
    // useFilteredWorktrees can run synchronously without re-fetching.
    (async () => {
      try {
        const [override, defaultDir] = await Promise.all([
          invoke<string | null>("get_setting", { key: "worktreeBaseDir", scope: "global" }),
          invoke<string>("get_default_worktree_base_dir"),
        ]);
        useUIStore.getState().setWorktreeBaseDirOverride(override);
        useUIStore.getState().setWorktreeDefaultBaseDir(defaultDir);
      } catch {
        // Backend unavailable — filter will fall back to showing everything.
      }
    })();
  }, []);

  // -- Navigation shortcuts (always active) --

  useAppHotkey("OPEN_SETTINGS", () => {
    const isSettings = matchRoute({ to: "/settings", fuzzy: true });
    router.navigate({ to: isSettings ? "/" : "/settings/appearance" });
  });

  useAppHotkey("OPEN_COMMAND_PALETTE", () => {
    setCommandPaletteOpen(!useUIStore.getState().commandPaletteOpen);
  });

  useAppHotkey("OPEN_FILE_FINDER", () => {
    setFileFinderOpen(!useUIStore.getState().fileFinderOpen);
  });

  useAppHotkey("RUN_SCRIPT", () => {
    toggleRunScript();
  });

  useAppHotkey("SHOW_KEYBOARD_SHORTCUTS", () => {
    router.navigate({ to: "/settings/keyboard" });
  }, undefined, [router]);

  // -- Terminal / split pane shortcuts (only when terminal or split tab is active) --

  const generalTerminalActive = useUIStore((s) => s.generalTerminalActive);

  const selectedWorktreePath = useUIStore((s) => s.selectedWorktree?.path ?? null);
  const worktreeActiveTab = useUIStore((s) =>
    selectedWorktreePath
      ? s.worktreeNavStates[selectedWorktreePath]?.activeTab ?? null
      : null,
  );
  // Which of the worktree's terminals tabs is active and splittable. The Agent
  // system tab and every user tab are splittable; the Run tab is not.
  const worktreeActiveTerminalsTab = useUIStore((s) =>
    selectedWorktreePath
      ? s.worktreeNavStates[selectedWorktreePath]?.activeTerminalsTab ?? AGENT_PANE_ID
      : null,
  );
  const worktreeActiveTabIsUser = useUIStore((s) => {
    if (!selectedWorktreePath) return false;
    const nav = s.worktreeNavStates[selectedWorktreePath];
    const userTabs = nav?.userTabs;
    if (!userTabs || userTabs.length === 0) return false;
    const activeId = nav.activeTerminalsTab;
    return userTabs.some((t) => t.id === activeId);
  });
  const worktreeActiveTabIsSplittable =
    selectedWorktreePath !== null &&
    canSplitTerminalsTab(
      worktreeActiveTerminalsTab ?? AGENT_PANE_ID,
      useUIStore.getState().getWorktreeNavState(selectedWorktreePath).userTabs,
    );

  const handleSplit = (direction: "vertical" | "horizontal") => {
    const uiState = useUIStore.getState();
    if (uiState.generalTerminalActive) {
      const result = splitNode(uiState.generalTerminalSplitTree, uiState.generalTerminalFocusedPaneId, direction);
      if (result) {
        uiState.setGeneralTerminalSplitTree(result.tree);
        uiState.setGeneralTerminalFocusedPaneId(result.newLeafId);
      }
      return;
    }

    if (!selectedWorktreePath) return;
    // ⌘D / ⇧⌘D stay the fast path and create a shell.
    splitActiveTabPane(selectedWorktreePath, direction, {
      kind: "terminal",
      launch: "shell",
    });
  };

  const handleFocusAdjacentPane = (direction: 1 | -1) => {
    const uiState = useUIStore.getState();
    if (uiState.generalTerminalActive) {
      const targetId = getAdjacentLeafId(uiState.generalTerminalSplitTree, uiState.generalTerminalFocusedPaneId, direction);
      uiState.setGeneralTerminalFocusedPaneId(targetId);
      return;
    }

    if (!selectedWorktreePath) return;
    const nav = uiState.getWorktreeNavState(selectedWorktreePath);
    if (nav.activeTerminalsTab === AGENT_PANE_ID) {
      focusAdjacentAgentTabPane(selectedWorktreePath, direction);
    } else if (worktreeActiveTabIsUser) {
      focusAdjacentUserTabPane(selectedWorktreePath, nav.activeTerminalsTab, direction);
    }
  };

  const splitEnabled =
    generalTerminalActive ||
    (selectedWorktreePath !== null &&
      worktreeActiveTab === "terminal" &&
      worktreeActiveTabIsSplittable);

  useAppHotkey(
    "SPLIT_VERTICAL",
    () => handleSplit("vertical"),
    { enabled: splitEnabled },
    [generalTerminalActive, selectedWorktreePath, worktreeActiveTab, worktreeActiveTabIsSplittable, worktreeActiveTabIsUser],
  );
  useAppHotkey(
    "SPLIT_HORIZONTAL",
    () => handleSplit("horizontal"),
    { enabled: splitEnabled },
    [generalTerminalActive, selectedWorktreePath, worktreeActiveTab, worktreeActiveTabIsSplittable, worktreeActiveTabIsUser],
  );
  useAppHotkey(
    "NEXT_PANE",
    () => handleFocusAdjacentPane(1),
    { enabled: splitEnabled },
    [generalTerminalActive, selectedWorktreePath, worktreeActiveTab, worktreeActiveTabIsSplittable, worktreeActiveTabIsUser],
  );
  useAppHotkey(
    "PREV_PANE",
    () => handleFocusAdjacentPane(-1),
    { enabled: splitEnabled },
    [generalTerminalActive, selectedWorktreePath, worktreeActiveTab, worktreeActiveTabIsSplittable, worktreeActiveTabIsUser],
  );

  const closePaneEnabled =
    generalTerminalActive ||
    (selectedWorktreePath !== null && worktreeActiveTab === "terminal");

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
          releaseCachedTerminal(sessionId);
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
      } else if (selectedWorktreePath) {
        const nav = uiState.getWorktreeNavState(selectedWorktreePath);
        const activeTabId = nav.activeTerminalsTab;
        // The Agent system tab closes only its focused split pane (never the
        // tab itself); the Run tab is unsplittable.
        if (activeTabId === AGENT_PANE_ID) {
          closeAgentTabFocusedPane(selectedWorktreePath);
          return;
        }
        if (activeTabId === RUN_PANE_ID) return;
        if (!nav.userTabs.some((t) => t.id === activeTabId)) return;
        closeUserTabFocusedPane(selectedWorktreePath, activeTabId);
      }
    },
    { enabled: closePaneEnabled },
    [generalTerminalActive, selectedWorktreePath, worktreeActiveTab],
  );

  // -- Worktree jump shortcuts (always active) --
  const worktrees = useFilteredWorktrees();
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

  // -- Switch to previous project (toggles between the two most recent) --
  useAppHotkey("SWITCH_TO_PREVIOUS_PROJECT", () => {
    const prev = useUIStore.getState().previousProject;
    if (!prev) return;
    const project = useDataStore
      .getState()
      .projects.find((p) => p.path === prev.path);
    if (project) selectProject(project);
  });

  if (checking) return null;

  if (gitError) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center">
          <h1 className="text-lg font-semibold mb-2">Git Not Found</h1>
          <p className="text-muted-foreground">
            Impala needs Git to read worktree changes.{" "}
            <button
              onClick={() => openUrl("https://git-scm.com/download")}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Install Git from git-scm.com
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`h-screen w-screen overflow-hidden text-foreground flex flex-col ${
        browserUnderlayEnabled ? "bg-transparent" : "bg-background"
      }`}
    >
      <Outlet />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
      <FileFinder
        open={fileFinderOpen}
        onClose={() => setFileFinderOpen(false)}
      />
      <Toaster />
      <UpdateChecker />
    </div>
  );
}

export default RootLayout;
