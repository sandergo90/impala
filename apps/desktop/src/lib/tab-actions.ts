import { invoke } from "@tauri-apps/api/core";
import { useUIStore, useDataStore } from "../store";
import { CLAUDE_PANE_ID, RUN_PANE_ID, userTabPaneId } from "./pane-ids";
import {
  splitNode,
  removeNode,
  getLeaves,
  getAdjacentLeafId,
  findLeaf,
} from "./split-tree";
import type { SplitNode, UserTab } from "../types";

/**
 * Return the effective split tree for a user tab. Phase-4+ tabs carry their
 * own `splitTree`. Older persisted tabs don't; we synthesize a single leaf
 * whose id matches the pre-Phase-4 paneId convention so the existing PTY
 * session key (`pty-tab-user-${tabId}`) still resolves.
 */
export function getEffectiveUserTabSplitTree(tab: UserTab): SplitNode {
  if (tab.splitTree) return tab.splitTree;
  const paneType = tab.kind === "claude" ? "claude" : "shell";
  return { type: "leaf", id: userTabPaneId(tab.id), paneType };
}

/**
 * Return the effective focused pane id for a user tab. Falls back to the
 * first leaf if the stored id is missing or no longer in the tree.
 */
export function getEffectiveUserTabFocusedPaneId(tab: UserTab): string {
  const tree = getEffectiveUserTabSplitTree(tab);
  const stored = tab.focusedPaneId;
  if (stored && findLeaf(tree, stored)) return stored;
  const leaves = getLeaves(tree);
  return leaves[0]?.id ?? userTabPaneId(tab.id);
}

/**
 * Allocate a new user tab, push it into the worktree's userTabs, and activate it.
 * Returns the newly created tab.
 */
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

/**
 * Kill the PTY for the given user tab, remove it from userTabs, and switch focus
 * to `previousActive` if it still resolves; otherwise fall back to the Claude tab.
 */
export function closeUserTab(
  worktreePath: string,
  tabId: string,
  { previousActive }: { previousActive: string | null },
): void {
  const uiState = useUIStore.getState();
  const dataStore = useDataStore.getState();

  const nav = uiState.getWorktreeNavState(worktreePath);
  if (!nav.userTabs.some((t) => t.id === tabId)) return;

  const paneId = userTabPaneId(tabId);
  const dataState = dataStore.getWorktreeDataState(worktreePath);
  const sessionId = dataState.paneSessions[paneId];
  if (sessionId) {
    invoke("pty_kill", { sessionId }).catch(() => {});
    const { [paneId]: _removed, ...remaining } = dataState.paneSessions;
    dataStore.updateWorktreeDataState(worktreePath, { paneSessions: remaining });
  }

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

/**
 * Rename a user tab. Silent no-op if `tabId` is not found or if `label.trim()`
 * is empty (the caller should treat the empty case as "revert to previous label").
 */
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

/**
 * Move a user tab to a new position within userTabs. `toTabId` is the tab
 * currently occupying the destination slot — the dragged tab is inserted
 * at that index (pushing the target tab over).
 *
 * Silent no-op if either ID is missing or if `fromTabId === toTabId`.
 */
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

/**
 * Return the ordered list of tab IDs currently visible: system tabs first, then user tabs.
 * Pure — no store writes. Used by hotkey handlers for prev/next navigation.
 */
export function getTabOrder(userTabs: UserTab[], hasRunTab: boolean): string[] {
  const order: string[] = [CLAUDE_PANE_ID];
  if (hasRunTab) order.push(RUN_PANE_ID);
  for (const t of userTabs) order.push(t.id);
  return order;
}

/**
 * Cycle the active tab by `delta` (+1 for next, -1 for previous). Wraps around.
 *
 * Uses heuristics to detect the Run tab without an async project-config read: if
 * paneSessions already contains tab-run, OR runStatus is non-idle, OR setupRanAt
 * was set, we treat the Run tab as present. Edge case: a run-configured worktree
 * whose Run tab has never materialised yet will cycle without it. Acceptable for
 * a navigation convenience.
 */
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

/**
 * Split the focused pane inside a user tab. Returns the new leaf id, or null
 * if the operation was a no-op (tab not found, or not a user tab).
 */
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

/**
 * Close the focused pane inside a user tab.
 * - If the tab has more than one leaf, the pane is removed and focus moves to
 *   the previously-adjacent pane. The tab survives.
 * - If the tab has exactly one leaf, the tab itself is closed (delegates to
 *   `closeUserTab` with `previousActive: null`).
 *
 * Kills the PTY session for the removed pane.
 */
export function closeUserTabFocusedPane(
  worktreePath: string,
  tabId: string,
): void {
  const uiState = useUIStore.getState();
  const dataStore = useDataStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tab = nav.userTabs.find((t) => t.id === tabId);
  if (!tab) return;

  const tree = getEffectiveUserTabSplitTree(tab);
  const leaves = getLeaves(tree);

  if (leaves.length <= 1) {
    closeUserTab(worktreePath, tabId, { previousActive: null });
    return;
  }

  const focusedId = getEffectiveUserTabFocusedPaneId(tab);
  const adjacentId = getAdjacentLeafId(tree, focusedId, -1);
  const newTree = removeNode(tree, focusedId);
  if (!newTree) {
    closeUserTab(worktreePath, tabId, { previousActive: null });
    return;
  }

  const sessionId = dataStore.getWorktreeDataState(worktreePath).paneSessions[focusedId];
  if (sessionId) {
    invoke("pty_kill", { sessionId }).catch(() => {});
    const dataState = dataStore.getWorktreeDataState(worktreePath);
    const { [focusedId]: _removed, ...remaining } = dataState.paneSessions;
    dataStore.updateWorktreeDataState(worktreePath, { paneSessions: remaining });
  }

  const newLeaves = getLeaves(newTree);
  const newFocusedId = newLeaves.some((l) => l.id === adjacentId)
    ? adjacentId
    : newLeaves[0]?.id ?? focusedId;

  const nextTabs = nav.userTabs.map((t) =>
    t.id === tabId ? { ...t, splitTree: newTree, focusedPaneId: newFocusedId } : t,
  );

  uiState.updateWorktreeNavState(worktreePath, { userTabs: nextTabs });
}

/**
 * Move focus to the next/previous leaf within a user tab's split tree.
 * `direction`: 1 for next, -1 for previous. Wraps around.
 * No-op on tabs with a single leaf.
 */
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

/**
 * Set the focused pane of a user tab directly (used by click-to-focus from
 * the renderer).
 */
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
