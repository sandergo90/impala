import { invoke } from "@tauri-apps/api/core";
import { useUIStore, useDataStore } from "../store";
import { AGENT_PANE_ID, RUN_PANE_ID, userTabPaneId } from "./pane-ids";
import { releaseCachedTerminal } from "../components/XtermTerminal";
import {
  splitNode,
  removeNode,
  getLeaves,
  getAdjacentLeafId,
  findLeaf,
} from "./split-tree";
import { basename } from "./path-utils";
import type { SplitNode, UserTab, WorktreeNavState } from "../types";

// Pre-Phase-4 persisted user tabs don't carry `splitTree`; synthesize a
// single leaf whose id matches the original `tab-user-${id}` convention so
// existing PTY sessions still resolve.
export function getEffectiveUserTabSplitTree(tab: UserTab): SplitNode {
  if (tab.splitTree) return tab.splitTree;
  const paneType = tab.kind === "agent" ? "agent" : "shell";
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

// Find the smallest positive integer >= `start` not currently in `used`.
function smallestUnused(used: Set<number>, start: number): number {
  let n = start;
  while (used.has(n)) n++;
  return n;
}

// Parse an auto-generated label like "Terminal 4" or "Agent 7" back to its
// number. Returns null for renamed tabs so their numeric slot is freed up
// and can be reused.
function parseLabelNumber(label: string, prefix: string): number | null {
  if (!label.startsWith(`${prefix} `)) return null;
  const n = Number(label.slice(prefix.length + 1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function createUserTab(
  worktreePath: string,
  kind: "terminal" | "agent",
): UserTab {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);

  // Slot = smallest positive integer not already in use by another tab of
  // this kind. Agent starts at 2 because the primary Agent pane is
  // conceptually "Agent 1". Renamed tabs don't occupy a slot.
  const prefix = kind === "terminal" ? "Terminal" : "Agent";
  const startAt = kind === "terminal" ? 1 : 2;
  const used = new Set<number>();
  for (const t of nav.userTabs) {
    if (t.kind !== kind) continue;
    const n = parseLabelNumber(t.label, prefix);
    if (n !== null) used.add(n);
  }
  const slot = smallestUnused(used, startAt);
  const label = `${prefix} ${slot}`;
  const tabId = `${kind}-${slot}-${Date.now()}`;
  const rootLeaf: SplitNode = {
    type: "leaf",
    id: userTabPaneId(tabId),
    paneType: kind === "agent" ? "agent" : "shell",
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
    activeTerminalsTab: newTab.id,
  });

  return newTab;
}

export function closeUserTab(worktreePath: string, tabId: string): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const closedIndex = nav.userTabs.findIndex((t) => t.id === tabId);
  if (closedIndex === -1) return;

  const tab = nav.userTabs[closedIndex];
  if (tab.kind !== "file") {
    const tree = getEffectiveUserTabSplitTree(tab);
    for (const leaf of getLeaves(tree)) killPaneSession(worktreePath, leaf.id);
  }

  const remainingTabs = nav.userTabs.filter((t) => t.id !== tabId);

  // If the closed tab wasn't active, leave the active selection alone.
  // Otherwise jump to the neighbour immediately before this one in tab
  // order: previous user tab -> Run (if it exists) -> Agent.
  let nextActive = nav.activeTerminalsTab;
  if (nav.activeTerminalsTab === tabId) {
    const prevUserTab = remainingTabs[closedIndex - 1];
    if (prevUserTab) {
      nextActive = prevUserTab.id;
    } else {
      const hasRunTab = useDataStore
        .getState()
        .getWorktreeDataState(worktreePath).paneSessions[RUN_PANE_ID] !== undefined;
      nextActive = hasRunTab ? RUN_PANE_ID : AGENT_PANE_ID;
    }
  }

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
  const order: string[] = [AGENT_PANE_ID];
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
    : AGENT_PANE_ID;
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
    closeUserTab(worktreePath, tabId);
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

/**
 * Open a file in the dynamic tab bar with VS Code preview/pin semantics.
 *
 * - If a pinned tab for this exact path already exists, just activate it.
 * - Else if a preview tab (kind: "file", pinned: false) exists, retarget
 *   its path; do not create a new tab. If `pin` is true, the preview is
 *   promoted to pinned at the same time.
 * - Otherwise create a fresh tab (preview unless `pin` is true).
 */
export function openFileTab(
  worktreePath: string,
  path: string,
  pin: boolean,
): UserTab {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const label = basename(path);

  // Only force the top-level tab area to "terminal" when the user is on a
  // mode where TabbedTerminals isn't visible. "terminal" and "split" already
  // show terminal content; flipping them would collapse the user's layout.
  const needsTabAreaSwitch =
    nav.activeTab === "diff" || nav.activeTab === "plan";

  // Pinned tab for this path already exists — just activate it.
  const existingPinned = nav.userTabs.find(
    (t) => t.kind === "file" && t.pinned && t.path === path,
  );
  if (existingPinned) {
    const updates: Partial<WorktreeNavState> = {
      activeTerminalsTab: existingPinned.id,
    };
    if (needsTabAreaSwitch) updates.activeTab = "terminal";
    uiState.updateWorktreeNavState(worktreePath, updates);
    return existingPinned;
  }

  const previewTab = nav.userTabs.find(
    (t) => t.kind === "file" && !t.pinned,
  );

  if (previewTab) {
    const updated: UserTab = {
      ...previewTab,
      path,
      label,
      pinned: pin || previewTab.pinned,
    };
    const next = nav.userTabs.map((t) =>
      t.id === previewTab.id ? updated : t,
    );
    const updates: Partial<WorktreeNavState> = {
      userTabs: next,
      activeTerminalsTab: updated.id,
    };
    if (needsTabAreaSwitch) updates.activeTab = "terminal";
    uiState.updateWorktreeNavState(worktreePath, updates);
    return updated;
  }

  // No preview tab; create one.
  const tabId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const newTab: UserTab = {
    id: tabId,
    kind: "file",
    label,
    createdAt: Date.now(),
    path,
    pinned: pin,
  };
  const updates: Partial<WorktreeNavState> = {
    userTabs: [...nav.userTabs, newTab],
    activeTerminalsTab: tabId,
  };
  if (needsTabAreaSwitch) updates.activeTab = "terminal";
  uiState.updateWorktreeNavState(worktreePath, updates);
  return newTab;
}
