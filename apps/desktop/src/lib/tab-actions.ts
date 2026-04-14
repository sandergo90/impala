import { invoke } from "@tauri-apps/api/core";
import { useUIStore, useDataStore } from "../store";
import { CLAUDE_PANE_ID, RUN_PANE_ID, userTabPaneId } from "./pane-ids";
import type { UserTab } from "../types";

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
  const newTab: UserTab = {
    id: `${kind}-${counter}-${Date.now()}`,
    kind,
    label,
    createdAt: Date.now(),
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
