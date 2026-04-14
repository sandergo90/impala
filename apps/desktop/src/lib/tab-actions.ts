import { invoke } from "@tauri-apps/api/core";
import { useUIStore, useDataStore } from "../store";
import { CLAUDE_PANE_ID, RUN_PANE_ID, userTabPaneId } from "./pane-ids";
import { releaseCachedTerminal } from "../components/XtermTerminal";
import {
  splitNode,
  removeNode,
  getLeaves,
  getAdjacentLeafId,
  findLeaf,
} from "./split-tree";
import type { SplitNode, UserTab } from "../types";

// Pre-Phase-4 persisted user tabs don't carry `splitTree`; synthesize a
// single leaf whose id matches the original `tab-user-${id}` convention so
// existing PTY sessions still resolve.
export function getEffectiveUserTabSplitTree(tab: UserTab): SplitNode {
  if (tab.splitTree) return tab.splitTree;
  const paneType = tab.kind === "claude" ? "claude" : "shell";
  return { type: "leaf", id: userTabPaneId(tab.id), paneType };
}

export function getEffectiveUserTabFocusedPaneId(tab: UserTab): string {
  const tree = getEffectiveUserTabSplitTree(tab);
  const stored = tab.focusedPaneId;
  if (stored && findLeaf(tree, stored)) return stored;
  return getLeaves(tree)[0]?.id ?? userTabPaneId(tab.id);
}

function killPaneSession(worktreePath: string, paneId: string): void {
  const dataStore = useDataStore.getState();
  const dataState = dataStore.getWorktreeDataState(worktreePath);
  const sessionId = dataState.paneSessions[paneId];
  if (!sessionId) return;
  invoke("pty_kill", { sessionId }).catch(() => {});
  releaseCachedTerminal(sessionId);
  const { [paneId]: _removed, ...remaining } = dataState.paneSessions;
  dataStore.updateWorktreeDataState(worktreePath, { paneSessions: remaining });
}

export function createUserTab(
  worktreePath: string,
  kind: "terminal" | "claude",
): UserTab {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);

  const counter = nav.tabCounters[kind];
  const label = kind === "terminal" ? `Terminal ${counter}` : `Claude ${counter}`;
  const tabId = `${kind}-${counter}-${Date.now()}`;
  const rootLeaf: SplitNode = {
    type: "leaf",
    id: userTabPaneId(tabId),
    paneType: kind === "claude" ? "claude" : "shell",
  };
  const newTab: UserTab = {
    id: tabId,
    kind,
    label,
    createdAt: Date.now(),
    splitTree: rootLeaf,
    focusedPaneId: rootLeaf.id,
  };

  uiState.updateWorktreeNavState(worktreePath, {
    userTabs: [...nav.userTabs, newTab],
    tabCounters: { ...nav.tabCounters, [kind]: counter + 1 },
    activeTerminalsTab: newTab.id,
  });

  return newTab;
}

export function closeUserTab(
  worktreePath: string,
  tabId: string,
  { previousActive }: { previousActive: string | null },
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  if (!nav.userTabs.some((t) => t.id === tabId)) return;

  const tab = nav.userTabs.find((t) => t.id === tabId)!;
  const tree = getEffectiveUserTabSplitTree(tab);
  for (const leaf of getLeaves(tree)) killPaneSession(worktreePath, leaf.id);

  const remainingTabs = nav.userTabs.filter((t) => t.id !== tabId);

  const validIds = new Set<string>([
    CLAUDE_PANE_ID,
    RUN_PANE_ID,
    ...remainingTabs.map((t) => t.id),
  ]);
  const nextActive =
    previousActive && validIds.has(previousActive) ? previousActive : CLAUDE_PANE_ID;

  uiState.updateWorktreeNavState(worktreePath, {
    userTabs: remainingTabs,
    activeTerminalsTab: nextActive,
  });
}

// Empty trimmed label is a no-op; callers treat it as "revert to previous".
export function renameUserTab(
  worktreePath: string,
  tabId: string,
  label: string,
): void {
  const trimmed = label.trim();
  if (!trimmed) return;
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  if (!nav.userTabs.some((t) => t.id === tabId)) return;
  const next = nav.userTabs.map((t) =>
    t.id === tabId ? { ...t, label: trimmed } : t,
  );
  uiState.updateWorktreeNavState(worktreePath, { userTabs: next });
}

export function reorderUserTabs(
  worktreePath: string,
  fromTabId: string,
  toTabId: string,
): void {
  if (fromTabId === toTabId) return;
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);

  const fromIndex = nav.userTabs.findIndex((t) => t.id === fromTabId);
  const toIndex = nav.userTabs.findIndex((t) => t.id === toTabId);
  if (fromIndex === -1 || toIndex === -1) return;

  const next = [...nav.userTabs];
  const [moved] = next.splice(fromIndex, 1);
  // After splice, toIndex may have shifted by 1 if fromIndex < toIndex.
  const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
  next.splice(adjustedToIndex, 0, moved);

  uiState.updateWorktreeNavState(worktreePath, { userTabs: next });
}

export function getTabOrder(userTabs: UserTab[], hasRunTab: boolean): string[] {
  const order: string[] = [CLAUDE_PANE_ID];
  if (hasRunTab) order.push(RUN_PANE_ID);
  for (const t of userTabs) order.push(t.id);
  return order;
}

// Uses heuristics to detect the Run tab without an async project-config read:
// paneSessions has tab-run, OR runStatus is non-idle, OR setupRanAt was set.
// Edge case: a run-configured worktree whose Run tab has never materialised
// yet will cycle without it. Acceptable for a navigation convenience.
export function stepActiveTab(worktreePath: string, delta: 1 | -1): void {
  const uiState = useUIStore.getState();
  const dataStore = useDataStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);

  const paneSessions = dataStore.getWorktreeDataState(worktreePath).paneSessions;
  const hasRunTab =
    paneSessions[RUN_PANE_ID] !== undefined ||
    nav.runStatus !== "idle" ||
    nav.setupRanAt !== null;

  const order = getTabOrder(nav.userTabs, hasRunTab);
  if (order.length <= 1) return;

  const activeId = order.includes(nav.activeTerminalsTab)
    ? nav.activeTerminalsTab
    : CLAUDE_PANE_ID;
  const currentIndex = order.indexOf(activeId);
  const nextIndex = (currentIndex + delta + order.length) % order.length;
  const nextId = order[nextIndex];

  uiState.updateWorktreeNavState(worktreePath, { activeTerminalsTab: nextId });
}

export function splitUserTabPane(
  worktreePath: string,
  tabId: string,
  orientation: "horizontal" | "vertical",
): string | null {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tab = nav.userTabs.find((t) => t.id === tabId);
  if (!tab) return null;

  const tree = getEffectiveUserTabSplitTree(tab);
  const focusedId = getEffectiveUserTabFocusedPaneId(tab);

  const result = splitNode(tree, focusedId, orientation);
  if (!result) return null;

  const nextTabs = nav.userTabs.map((t) =>
    t.id === tabId
      ? { ...t, splitTree: result.tree, focusedPaneId: result.newLeafId }
      : t,
  );

  uiState.updateWorktreeNavState(worktreePath, { userTabs: nextTabs });
  return result.newLeafId;
}

// Multi-leaf tab: removes focused pane, advances focus to the previously-
// adjacent leaf. Single-leaf tab: delegates to closeUserTab.
export function closeUserTabFocusedPane(
  worktreePath: string,
  tabId: string,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tab = nav.userTabs.find((t) => t.id === tabId);
  if (!tab) return;

  const tree = getEffectiveUserTabSplitTree(tab);
  if (getLeaves(tree).length <= 1) {
    closeUserTab(worktreePath, tabId, { previousActive: null });
    return;
  }

  const focusedId = getEffectiveUserTabFocusedPaneId(tab);
  const adjacentId = getAdjacentLeafId(tree, focusedId, -1);
  const newTree = removeNode(tree, focusedId)!;

  killPaneSession(worktreePath, focusedId);

  const nextTabs = nav.userTabs.map((t) =>
    t.id === tabId ? { ...t, splitTree: newTree, focusedPaneId: adjacentId } : t,
  );
  uiState.updateWorktreeNavState(worktreePath, { userTabs: nextTabs });
}

export function focusAdjacentUserTabPane(
  worktreePath: string,
  tabId: string,
  direction: 1 | -1,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tab = nav.userTabs.find((t) => t.id === tabId);
  if (!tab) return;

  const tree = getEffectiveUserTabSplitTree(tab);
  const leaves = getLeaves(tree);
  if (leaves.length <= 1) return;

  const focusedId = getEffectiveUserTabFocusedPaneId(tab);
  const nextId = getAdjacentLeafId(tree, focusedId, direction);
  if (nextId === focusedId) return;

  const nextTabs = nav.userTabs.map((t) =>
    t.id === tabId ? { ...t, focusedPaneId: nextId } : t,
  );
  uiState.updateWorktreeNavState(worktreePath, { userTabs: nextTabs });
}

export function setUserTabFocusedPane(
  worktreePath: string,
  tabId: string,
  paneId: string,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tab = nav.userTabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (tab.focusedPaneId === paneId) return;
  const nextTabs = nav.userTabs.map((t) =>
    t.id === tabId ? { ...t, focusedPaneId: paneId } : t,
  );
  uiState.updateWorktreeNavState(worktreePath, { userTabs: nextTabs });
}
