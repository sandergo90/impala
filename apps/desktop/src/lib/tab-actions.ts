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
  const sessionId = dataStore.getWorktreeDataState(worktreePath).paneSessions[paneId];
  if (sessionId) {
    invoke("pty_kill", { sessionId }).catch(() => {});
    const current = dataStore.getWorktreeDataState(worktreePath);
    const { [paneId]: _removed, ...remaining } = current.paneSessions;
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
 * Return the ordered list of tab IDs currently visible: system tabs first, then user tabs.
 * Pure — no store writes. Used by hotkey handlers for prev/next navigation.
 */
export function getTabOrder(userTabs: UserTab[], hasRunTab: boolean): string[] {
  const order: string[] = [CLAUDE_PANE_ID];
  if (hasRunTab) order.push(RUN_PANE_ID);
  for (const t of userTabs) order.push(t.id);
  return order;
}
