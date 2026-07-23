import { useDataStore, useUIStore } from "../store";
import type { Worktree } from "../types";
import {
  getEffectiveAgentTabSplitTree,
  getEffectiveUserTabSplitTree,
} from "./tab-actions";
import {
  AGENT_PANE_ID,
  RUN_PANE_ID,
  panePtySessionId,
  runPtySessionId,
} from "./pane-ids";
import { findGroupTab, getLeaves, setActiveGroupTab } from "./split-tree";

export interface RunningService {
  port: number;
  address: string;
  pid: number;
  processName: string;
  worktreePath: string;
  sessionId: string | null;
  managed: boolean;
}

export function runningServiceUrl(service: RunningService): string {
  const address = service.address.replace(/^\[(.*)\]$/, "$1");
  const host = ["*", "0.0.0.0", "::", "127.0.0.1", "::1"].includes(address)
    ? "localhost"
    : address.includes(":")
      ? `[${address}]`
      : address;
  return `http://${host}:${service.port}`;
}

export type ServiceTerminalTarget =
  | { kind: "general" }
  | { kind: "worktree"; worktree: Worktree };

export function focusServiceTerminal(
  service: RunningService,
  worktrees: Worktree[],
): ServiceTerminalTarget | null {
  if (!service.sessionId) return null;

  const ui = useUIStore.getState();
  const data = useDataStore.getState();
  const generalPaneId = Object.entries(data.generalTerminalPaneSessions).find(
    ([, sessionId]) => sessionId === service.sessionId,
  )?.[0];
  if (generalPaneId) {
    const match = findGroupTab(ui.generalTerminalSplitTree, generalPaneId);
    if (!match) return null;
    ui.setGeneralTerminalSplitTree(
      setActiveGroupTab(ui.generalTerminalSplitTree, match.group.id, generalPaneId),
    );
    ui.setGeneralTerminalFocusedPaneId(match.group.id);
    return { kind: "general" };
  }

  for (const worktree of worktrees) {
    const nav = ui.getWorktreeNavState(worktree.path);
    const paneSessions = data.getWorktreeDataState(worktree.path).paneSessions;
    const persistedPaneIds = [
      RUN_PANE_ID,
      ...getLeaves(getEffectiveAgentTabSplitTree(nav.agentTabSplitTree))
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.content.kind === "terminal")
        .map((tab) => tab.id),
      ...nav.userTabs.flatMap((topTab) =>
        getLeaves(getEffectiveUserTabSplitTree(topTab))
          .flatMap((group) => group.tabs)
          .filter((tab) => tab.content.kind === "terminal")
          .map((tab) => tab.id),
      ),
    ];
    const paneId =
      Object.entries(paneSessions).find(
        ([, sessionId]) => sessionId === service.sessionId,
      )?.[0] ??
      persistedPaneIds.find((candidate) => {
        const expected =
          candidate === RUN_PANE_ID
            ? runPtySessionId(worktree.path)
            : panePtySessionId(worktree.path, candidate);
        return expected === service.sessionId;
      });
    if (!paneId) continue;

    if (paneId === RUN_PANE_ID) {
      ui.updateWorktreeNavState(worktree.path, {
        activeTab: "terminal",
        activeTerminalsTab: RUN_PANE_ID,
      });
      return { kind: "worktree", worktree };
    }
    if (focusPaneInWorktree(worktree.path, paneId)) {
      return { kind: "worktree", worktree };
    }
  }

  return null;
}

function focusPaneInWorktree(worktreePath: string, paneId: string): boolean {
  const ui = useUIStore.getState();
  const nav = ui.getWorktreeNavState(worktreePath);
  const agentTree = getEffectiveAgentTabSplitTree(nav.agentTabSplitTree);
  const agentMatch = findGroupTab(agentTree, paneId);
  if (agentMatch) {
    ui.updateWorktreeNavState(worktreePath, {
      activeTab: "terminal",
      activeTerminalsTab: AGENT_PANE_ID,
      agentTabSplitTree: setActiveGroupTab(agentTree, agentMatch.group.id, paneId),
      agentTabFocusedPaneId: agentMatch.group.id,
    });
    return true;
  }

  for (const topTab of nav.userTabs) {
    const tree = getEffectiveUserTabSplitTree(topTab);
    const match = findGroupTab(tree, paneId);
    if (!match) continue;
    ui.updateWorktreeNavState(worktreePath, {
      activeTab: "terminal",
      activeTerminalsTab: topTab.id,
      userTabs: nav.userTabs.map((candidate) =>
        candidate.id === topTab.id
          ? {
              ...candidate,
              splitTree: setActiveGroupTab(tree, match.group.id, paneId),
              focusedPaneId: match.group.id,
            }
          : candidate,
      ),
    });
    return true;
  }

  return false;
}
