import { invoke } from "@/lib/invoke";
import { useUIStore, useDataStore } from "../store";
import { AGENT_PANE_ID, RUN_PANE_ID, userTabPaneId } from "./pane-ids";
import { releaseCachedTerminal } from "../components/XtermTerminal";
import {
  splitNode,
  removeNode,
  getLeaves,
  getAdjacentLeafId,
  findLeaf,
  updateRatio,
  updateLeafContent,
  updateGroupTab,
  normalizeLegacySplitTree,
  createGroupTab,
  findGroupTab,
  getActiveGroupTab,
  getAdjacentGroupTabId,
  removeGroupTab,
  setActiveGroupTab,
  addTabToGroup,
  createGroup,
  shouldUseGroupTabs,
  getHorizontalNeighborGroupId,
  extractGroupTab,
  insertGroupTab,
  insertGroupAtEdge,
  moveGroupTab,
} from "./split-tree";
import type { PaneEdge } from "./split-tree";
import { basename } from "./path-utils";
import { useEditorDocsStore } from "../stores/editor-docs";
import { buildDocumentKey } from "./editor-buffer-registry";
import type { GroupTab, PaneContent, SplitNode, UserTab, WorktreeNavState } from "../types";
import type { Agent } from "./agent";

// The pane content a single-leaf tab shows, derived from its `kind` + the
// `path`/`url` mirror. Keep in sync with the leaf `content` written at
// creation and the v7 migration.
function contentForTab(tab: UserTab): PaneContent {
  switch (tab.kind) {
    case "agent":
      return { kind: "agent" };
    case "file":
      return { kind: "file", path: tab.path ?? "" };
    case "browser":
      return { kind: "browser", url: tab.url };
    default:
      return { kind: "shell" };
  }
}

function singleGroup(
  id: string,
  content: PaneContent,
  label?: string,
  pinned?: boolean,
): Extract<SplitNode, { type: "group" }> {
  const groupTab = { ...createGroupTab(id, content, label), ...(pinned ? { pinned } : {}) };
  return { type: "group", id, tabs: [groupTab], activeTabId: groupTab.id };
}

// Belt-and-braces for any tab that slips through without a tree: synthesize a
// single leaf whose id matches the `tab-user-${id}` convention so existing PTY
// sessions still resolve and the primary browser/file leaf keeps its id.
export function getEffectiveUserTabSplitTree(tab: UserTab): SplitNode {
  if (tab.splitTree) {
    return normalizeLegacySplitTree(tab.splitTree, contentForTab(tab));
  }
  return singleGroup(userTabPaneId(tab.id), contentForTab(tab), tab.label);
}

export function getEffectiveUserTabFocusedPaneId(tab: UserTab): string {
  const tree = getEffectiveUserTabSplitTree(tab);
  const stored = tab.focusedPaneId;
  if (stored && findLeaf(tree, stored)) return stored;
  return getLeaves(tree)[0]?.id ?? userTabPaneId(tab.id);
}

function getPrimaryGroupTabId(tab: UserTab): string {
  const tree = getEffectiveUserTabSplitTree(tab);
  const conventionalId = userTabPaneId(tab.id);
  if (findGroupTab(tree, conventionalId)) return conventionalId;
  return getLeaves(tree)[0]?.tabs[0]?.id ?? conventionalId;
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
  initialPrompt?: string,
  initialAgent?: Agent,
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
  const rootLeaf = singleGroup(
    userTabPaneId(tabId),
    kind === "agent" ? { kind: "agent" } : { kind: "shell" },
    label,
  );
  const newTab: UserTab = {
    id: tabId,
    kind,
    label,
    createdAt: Date.now(),
    splitTree: rootLeaf,
    focusedPaneId: rootLeaf.id,
  };

  const prompt = initialPrompt?.trim();
  if (kind === "agent" && prompt) {
    pendingAgentLaunches.set(rootLeaf.id, { prompt, agent: initialAgent });
  }

  uiState.updateWorktreeNavState(worktreePath, {
    userTabs: [...nav.userTabs, newTab],
    activeTerminalsTab: newTab.id,
  });

  return newTab;
}

// Prompt handoffs are intentionally in-memory: once the new agent's launch
// command has been written, a later PTY recovery must not replay the task.
interface PendingAgentLaunch {
  prompt: string;
  agent?: Agent;
}

const pendingAgentLaunches = new Map<string, PendingAgentLaunch>();

export function getPendingAgentLaunch(
  paneId: string,
): PendingAgentLaunch | undefined {
  return pendingAgentLaunches.get(paneId);
}

export function clearPendingAgentLaunch(paneId: string): void {
  pendingAgentLaunches.delete(paneId);
}

export function createBrowserTab(worktreePath: string, url?: string): UserTab {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);

  const used = new Set<number>();
  for (const t of nav.userTabs) {
    if (t.kind !== "browser") continue;
    const n = parseLabelNumber(t.label, "Browser");
    if (n !== null) used.add(n);
  }
  const slot = smallestUnused(used, 1);
  const tabId = `browser-${slot}-${Date.now()}`;
  const rootLeaf = singleGroup(
    userTabPaneId(tabId),
    { kind: "browser", url },
    `Browser ${slot}`,
  );
  const newTab: UserTab = {
    id: tabId,
    kind: "browser",
    label: `Browser ${slot}`,
    createdAt: Date.now(),
    url,
    splitTree: rootLeaf,
    focusedPaneId: rootLeaf.id,
  };

  uiState.updateWorktreeNavState(worktreePath, {
    userTabs: [...nav.userTabs, newTab],
    activeTerminalsTab: newTab.id,
  });

  return newTab;
}

/** Open (or reuse) the worktree's browser tab at a URL and bring it on screen. */
export function openBrowserTabAt(worktreePath: string, url: string): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const existing = nav.userTabs.find((t) => t.kind === "browser");
  if (existing) {
    // The webview label is `browser-{paneId}`; target the tab's primary
    // browser leaf. No-ops if the webview doesn't exist yet; the updated leaf
    // url seeds browser_open on mount instead.
    const primaryPaneId = getPrimaryGroupTabId(existing);
    invoke("browser_navigate", { id: primaryPaneId, url }).catch(() => {});
    const nextTree = updateLeafContent(
      getEffectiveUserTabSplitTree(existing),
      primaryPaneId,
      (c) => (c.kind === "browser" ? { ...c, url } : c),
    );
    uiState.updateWorktreeNavState(worktreePath, {
      userTabs: nav.userTabs.map((t) =>
        t.id === existing.id ? { ...t, url, splitTree: nextTree } : t,
      ),
      activeTerminalsTab: existing.id,
      activeTab: "terminal",
    });
  } else {
    createBrowserTab(worktreePath, url);
    uiState.updateWorktreeNavState(worktreePath, { activeTab: "terminal" });
  }
}

export function closeUserTab(worktreePath: string, tabId: string): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const closedIndex = nav.userTabs.findIndex((t) => t.id === tabId);
  if (closedIndex === -1) return;

  const tab = nav.userTabs[closedIndex];
  const groupTabs = getLeaves(getEffectiveUserTabSplitTree(tab)).flatMap(
    (group) => group.tabs,
  );
  if (groupTabs.some((groupTab) => !confirmGroupTabClose(worktreePath, groupTab))) {
    return;
  }
  // Dispose every pane in the tree by kind: kill PTYs for terminal/agent
  // leaves, close the native webview for each browser leaf (label
  // `browser-{paneId}`). File leaves need no teardown here.
  for (const groupTab of groupTabs) disposeGroupTab(worktreePath, groupTab);

  const remainingTabs = nav.userTabs.filter((t) => t.id !== tabId);
  const hasRunTab =
    useDataStore.getState().getWorktreeDataState(worktreePath).paneSessions[
      RUN_PANE_ID
    ] !== undefined;

  // The closed tab must never linger in history. Stale IDs (from tabs closed
  // earlier) also get filtered when we look for the next active below.
  const trimmedHistory = (nav.tabHistory ?? []).filter((id) => id !== tabId);

  const isResolvable = (id: string): boolean => {
    if (id === AGENT_PANE_ID) return true;
    if (id === RUN_PANE_ID) return hasRunTab;
    return remainingTabs.some((t) => t.id === id);
  };

  let nextActive = nav.activeTerminalsTab;
  let nextHistory = trimmedHistory;
  if (nav.activeTerminalsTab === tabId) {
    // Pop the most recent history entry that still points at a visible tab.
    // Discarded entries are dropped from history at the same time.
    nextHistory = [...trimmedHistory];
    let picked: string | null = null;
    while (nextHistory.length > 0) {
      const candidate = nextHistory.pop()!;
      if (isResolvable(candidate)) {
        picked = candidate;
        break;
      }
    }
    nextActive = picked ?? (hasRunTab ? RUN_PANE_ID : AGENT_PANE_ID);
  }

  uiState.updateWorktreeNavState(worktreePath, {
    userTabs: remainingTabs,
    activeTerminalsTab: nextActive,
    tabHistory: nextHistory,
  });

  const closedFilePaths = groupTabs.flatMap((groupTab) =>
    groupTab.content.kind === "file" ? [groupTab.content.path] : [],
  );
  if (closedFilePaths.length > 0) {
    // Clear a stale tree-reveal pointing at the just-closed file. Otherwise
    // the FilesPanel reveal effect re-fires on the next worktree switch
    // (treePaths change) and re-opens the tab via onSelectionChange.
    const reveal = useUIStore.getState().pendingTreeReveal;
    if (
      reveal &&
      reveal.worktreePath === worktreePath &&
      closedFilePaths.includes(reveal.path)
    ) {
      useUIStore.setState({ pendingTreeReveal: null });
    }
  }
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

export type WorkspaceTabDragSource =
  | { type: "top-level"; topTabId: string }
  | {
      type: "group-tab";
      ownerTopTabId: string;
      groupId: string;
      groupTabId: string;
    };

export type PaneDropPlacement = PaneEdge | "center";

export type WorkspaceTabDropTarget =
  | { type: "top-level"; index?: number }
  | {
      type: "group";
      ownerTopTabId: string;
      groupId: string;
      index?: number;
    }
  | {
      type: "pane";
      ownerTopTabId: string;
      groupId: string;
      placement: PaneDropPlacement;
    };

function userTabFromGroupTab(groupTab: GroupTab): UserTab {
  const id = `promoted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tree: SplitNode = {
    type: "group",
    id: groupTab.id,
    tabs: [groupTab],
    activeTabId: groupTab.id,
  };
  return withPrimaryContent(
    {
      id,
      kind: userKindForContent(groupTab.content),
      label: groupTab.label,
      createdAt: groupTab.createdAt,
      splitTree: tree,
      focusedPaneId: tree.id,
    },
    tree,
  );
}

/**
 * Atomically move an existing content tab between the workspace's visible tab
 * strips. This deliberately bypasses every close/dispose path so PTYs,
 * webviews, editor buffers, and pending agent launches keep their identity.
 */
export function moveWorkspaceTab(
  worktreePath: string,
  source: WorkspaceTabDragSource,
  target: WorkspaceTabDropTarget,
): boolean {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const normalizedTarget: WorkspaceTabDropTarget =
    target.type === "pane" && target.placement === "center"
      ? {
          type: "group",
          ownerTopTabId: target.ownerTopTabId,
          groupId: target.groupId,
        }
      : target;

  if (source.type === "top-level" && normalizedTarget.type === "top-level") {
    const fromIndex = nav.userTabs.findIndex((tab) => tab.id === source.topTabId);
    if (fromIndex < 0) return false;
    const toIndex = Math.max(
      0,
      Math.min(normalizedTarget.index ?? nav.userTabs.length - 1, nav.userTabs.length - 1),
    );
    if (fromIndex === toIndex) return false;
    const userTabs = [...nav.userTabs];
    const [moved] = userTabs.splice(fromIndex, 1);
    userTabs.splice(toIndex, 0, moved);
    uiState.updateWorktreeNavState(worktreePath, { userTabs });
    return true;
  }

  if (source.type === "group-tab" && normalizedTarget.type === "top-level") {
    if (source.groupTabId === AGENT_PANE_ID) return false;
    const isAgentOwner = source.ownerTopTabId === AGENT_PANE_ID;
    const ownerTab = isAgentOwner
      ? null
      : nav.userTabs.find((tab) => tab.id === source.ownerTopTabId);
    const tree = isAgentOwner
      ? getEffectiveAgentTabSplitTree(nav.agentTabSplitTree)
      : ownerTab
        ? getEffectiveUserTabSplitTree(ownerTab)
        : null;
    if (!tree || getLeaves(tree)[0]?.id === source.groupId) return false;
    const extracted = extractGroupTab(tree, source.groupId, source.groupTabId);
    if (!extracted.tree || !extracted.tab) return false;

    const promoted = userTabFromGroupTab(extracted.tab);
    const userTabs = nav.userTabs.map((tab) => {
      if (!ownerTab || tab.id !== ownerTab.id) return tab;
      return {
        ...withPrimaryContent(tab, extracted.tree!),
        focusedPaneId: getLeaves(extracted.tree!)[0]?.id,
      };
    });
    const insertionIndex = Math.max(
      0,
      Math.min(normalizedTarget.index ?? userTabs.length, userTabs.length),
    );
    userTabs.splice(insertionIndex, 0, promoted);

    uiState.updateWorktreeNavState(worktreePath, {
      ...(isAgentOwner
        ? {
            agentTabSplitTree: extracted.tree,
            agentTabFocusedPaneId: getLeaves(extracted.tree)[0]?.id,
          }
        : {}),
      userTabs,
      activeTab: "terminal",
      activeTerminalsTab: promoted.id,
    });
    return true;
  }

  if (normalizedTarget.type !== "group" && normalizedTarget.type !== "pane") {
    return false;
  }
  const edge: PaneEdge | null =
    normalizedTarget.type === "pane" && normalizedTarget.placement !== "center"
    ? normalizedTarget.placement
    : null;
  const targetIndex = normalizedTarget.type === "group"
    ? normalizedTarget.index
    : undefined;
  const targetIsAgent = normalizedTarget.ownerTopTabId === AGENT_PANE_ID;
  const targetOwner = targetIsAgent
    ? null
    : nav.userTabs.find((tab) => tab.id === normalizedTarget.ownerTopTabId);
  const targetTree = targetIsAgent
    ? getEffectiveAgentTabSplitTree(nav.agentTabSplitTree)
    : targetOwner
      ? getEffectiveUserTabSplitTree(targetOwner)
      : null;
  if (!targetTree) return false;
  const primaryGroupId = getLeaves(targetTree)[0]?.id;
  const targetIsPrimary = primaryGroupId === normalizedTarget.groupId;
  // Center drops would create invisible group tabs in the primary pane. Left
  // and top edge drops would replace the first group and move the workspace's
  // top-level/system strip into the dragged content. Preserve that invariant.
  if (
    targetIsPrimary &&
    (edge === null || edge === "left" || edge === "top")
  ) {
    return false;
  }

  if (source.type === "top-level") {
    const sourceTab = nav.userTabs.find((tab) => tab.id === source.topTabId);
    if (!sourceTab || sourceTab.id === normalizedTarget.ownerTopTabId) return false;
    const sourceTree = getEffectiveUserTabSplitTree(sourceTab);
    const sourceGroups = getLeaves(sourceTree);
    if (sourceGroups.length !== 1 || sourceGroups[0].tabs.length !== 1) return false;
    const groupTab = sourceGroups[0].tabs[0];
    const nextTargetTree = edge
      ? insertGroupAtEdge(targetTree, normalizedTarget.groupId, edge, groupTab)
      : insertGroupTab(
          targetTree,
          normalizedTarget.groupId,
          groupTab,
          targetIndex,
        );
    if (nextTargetTree === targetTree) return false;
    const destinationGroupId = edge
      ? findGroupTab(nextTargetTree, groupTab.id)?.group.id
      : normalizedTarget.groupId;
    if (!destinationGroupId) return false;

    const userTabs = nav.userTabs
      .filter((tab) => tab.id !== sourceTab.id)
      .map((tab) =>
        targetOwner && tab.id === targetOwner.id
          ? {
              ...withPrimaryContent(tab, nextTargetTree),
              focusedPaneId: destinationGroupId,
            }
          : tab,
      );
    uiState.updateWorktreeNavState(worktreePath, {
      ...(targetIsAgent
        ? {
            agentTabSplitTree: nextTargetTree,
            agentTabFocusedPaneId: destinationGroupId,
          }
        : {}),
      userTabs,
      activeTab: "terminal",
      activeTerminalsTab: normalizedTarget.ownerTopTabId,
      tabHistory: (nav.tabHistory ?? []).filter((id) => id !== sourceTab.id),
    });
    return true;
  }

  if (source.ownerTopTabId !== normalizedTarget.ownerTopTabId) return false;
  if (getLeaves(targetTree)[0]?.id === source.groupId) return false;
  const sourceGroup = findLeaf(targetTree, source.groupId);
  if (!sourceGroup) return false;
  if (edge && source.groupId === normalizedTarget.groupId && sourceGroup.tabs.length === 1) {
    return false;
  }
  const nextTree = edge
    ? (() => {
        const extracted = extractGroupTab(
          targetTree,
          source.groupId,
          source.groupTabId,
        );
        if (!extracted.tree || !extracted.tab) return targetTree;
        return insertGroupAtEdge(
          extracted.tree,
          normalizedTarget.groupId,
          edge,
          extracted.tab,
        );
      })()
    : moveGroupTab(
        targetTree,
        source.groupId,
        source.groupTabId,
        normalizedTarget.groupId,
        targetIndex,
      );
  if (nextTree === targetTree) return false;
  const destinationGroupId = edge
    ? findGroupTab(nextTree, source.groupTabId)?.group.id
    : normalizedTarget.groupId;
  if (!destinationGroupId) return false;
  uiState.updateWorktreeNavState(worktreePath, {
    ...(targetIsAgent
      ? {
          agentTabSplitTree: nextTree,
          agentTabFocusedPaneId: destinationGroupId,
        }
      : {
          userTabs: nav.userTabs.map((tab) =>
            targetOwner && tab.id === targetOwner.id
              ? {
                  ...withPrimaryContent(tab, nextTree),
                  focusedPaneId: destinationGroupId,
                }
              : tab,
          ),
        }),
    activeTab: "terminal",
    activeTerminalsTab: normalizedTarget.ownerTopTabId,
  });
  return true;
}

// Mirrors the tab order rendered by TabbedTerminals: Run (if present), then
// Agent, then user tabs left-to-right. Keep in sync so Cmd+Left/Right cycle
// matches the visible tab strip.
export function getTabOrder(userTabs: UserTab[], hasRunTab: boolean): string[] {
  const order: string[] = [];
  if (hasRunTab) order.push(RUN_PANE_ID);
  order.push(AGENT_PANE_ID);
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
  content: PaneContent = { kind: "shell" },
): string | null {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tab = nav.userTabs.find((t) => t.id === tabId);
  if (!tab) return null;

  const tree = getEffectiveUserTabSplitTree(tab);
  const focusedId = getEffectiveUserTabFocusedPaneId(tab);

  const result = splitNode(tree, focusedId, orientation, content);
  if (!result) return null;

  const nextTabs = nav.userTabs.map((t) =>
    t.id === tabId
      ? { ...t, splitTree: result.tree, focusedPaneId: result.newLeafId }
      : t,
  );

  uiState.updateWorktreeNavState(worktreePath, { userTabs: nextTabs });
  return result.newLeafId;
}

export function canSplitTerminalsTab(
  activeTabId: string,
  userTabs: UserTab[],
): boolean {
  return (
    activeTabId === AGENT_PANE_ID || userTabs.some((tab) => tab.id === activeTabId)
  );
}

/** Route a split request for the currently active Agent or user tab. */
export function splitActiveTabPane(
  worktreePath: string,
  orientation: "horizontal" | "vertical",
  content: PaneContent = { kind: "shell" },
): string | null {
  const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
  if (nav.activeTerminalsTab === AGENT_PANE_ID) {
    return splitAgentTabPane(worktreePath, orientation, content);
  }
  if (nav.userTabs.some((tab) => tab.id === nav.activeTerminalsTab)) {
    return splitUserTabPane(
      worktreePath,
      nav.activeTerminalsTab,
      orientation,
      content,
    );
  }
  return null;
}

export function addTabToActivePane(
  worktreePath: string,
  content: PaneContent,
  initialPrompt?: string,
  initialAgent?: Agent,
): string | null {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const newTab = createGroup(content).tabs[0];
  const prompt = initialPrompt?.trim();
  if (content.kind === "agent" && prompt) {
    pendingAgentLaunches.set(newTab.id, { prompt, agent: initialAgent });
  }

  if (nav.activeTerminalsTab === AGENT_PANE_ID) {
    const tree = getEffectiveAgentTabSplitTree(nav.agentTabSplitTree);
    const groupId = getEffectiveAgentTabFocusedPaneId(
      nav.agentTabSplitTree,
      nav.agentTabFocusedPaneId,
    );
    uiState.updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: addTabToGroup(tree, groupId, newTab),
    });
    return newTab.id;
  }

  const topTab = nav.userTabs.find((tab) => tab.id === nav.activeTerminalsTab);
  if (!topTab) return null;
  const tree = getEffectiveUserTabSplitTree(topTab);
  const groupId = getEffectiveUserTabFocusedPaneId(topTab);
  uiState.updateWorktreeNavState(worktreePath, {
    userTabs: nav.userTabs.map((tab) =>
      tab.id === topTab.id
        ? { ...tab, splitTree: addTabToGroup(tree, groupId, newTab) }
        : tab,
    ),
  });
  return newTab.id;
}

/**
 * Create an MCP-requested agent tab next to the agent that made the request.
 * Secondary split panes own their local tab strip; the primary pane continues
 * to use the top-level tab strip. Sessions created before IMPALA_PANE_ID was
 * introduced fall back to the currently focused pane.
 */
export function createAgentTabFromRequest(
  worktreePath: string,
  initialPrompt: string,
  initialAgent?: Agent,
  sourcePaneId?: string,
  placement: "auto" | "current" | "left" | "right" = "auto",
): string {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);

  const addToRequestedGroup = (
    tree: SplitNode,
    update: (nextTree: SplitNode, groupId: string) => void,
    fallbackGroupId?: string,
  ): string | null => {
    const sourceGroup = sourcePaneId
      ? findGroupTab(tree, sourcePaneId)?.group
      : fallbackGroupId
        ? findLeaf(tree, fallbackGroupId)
        : null;
    if (!sourceGroup) return null;

    const targetGroupId =
      placement === "left" || placement === "right"
        ? getHorizontalNeighborGroupId(tree, sourceGroup.id, placement)
        : sourceGroup.id;
    if (!targetGroupId) return null;
    // The first group's tabs are represented by the workspace's top-level
    // strip. Adding an inner tab there would make it active but invisible.
    if (getLeaves(tree)[0]?.id === targetGroupId) {
      return null;
    }

    const newTab = createGroup({ kind: "agent" }).tabs[0];
    const prompt = initialPrompt.trim();
    if (prompt) {
      pendingAgentLaunches.set(newTab.id, { prompt, agent: initialAgent });
    }
    update(addTabToGroup(tree, targetGroupId, newTab), targetGroupId);
    return newTab.id;
  };

  const agentTree = getEffectiveAgentTabSplitTree(nav.agentTabSplitTree);
  const agentPaneTabId = addToRequestedGroup(
    agentTree,
    (nextTree, groupId) => {
      uiState.updateWorktreeNavState(worktreePath, {
        activeTab: "terminal",
        activeTerminalsTab: AGENT_PANE_ID,
        agentTabSplitTree: nextTree,
        agentTabFocusedPaneId: groupId,
      });
    },
    nav.activeTerminalsTab === AGENT_PANE_ID
      ? getEffectiveAgentTabFocusedPaneId(
          nav.agentTabSplitTree,
          nav.agentTabFocusedPaneId,
        )
      : undefined,
  );
  if (agentPaneTabId) return agentPaneTabId;

  for (const topTab of nav.userTabs) {
    const tree = getEffectiveUserTabSplitTree(topTab);
    const paneTabId = addToRequestedGroup(
      tree,
      (nextTree, groupId) => {
        uiState.updateWorktreeNavState(worktreePath, {
          activeTab: "terminal",
          activeTerminalsTab: topTab.id,
          userTabs: nav.userTabs.map((candidate) =>
            candidate.id === topTab.id
              ? { ...candidate, splitTree: nextTree, focusedPaneId: groupId }
              : candidate,
          ),
        });
      },
      nav.activeTerminalsTab === topTab.id
        ? getEffectiveUserTabFocusedPaneId(topTab)
        : undefined,
    );
    if (paneTabId) return paneTabId;
  }

  if (
    placement === "auto" &&
    !sourcePaneId &&
    shouldCreateTabInFocusedPane(worktreePath)
  ) {
    const paneTabId = addTabToActivePane(
      worktreePath,
      { kind: "agent" },
      initialPrompt,
      initialAgent,
    );
    if (paneTabId) {
      uiState.updateWorktreeNavState(worktreePath, { activeTab: "terminal" });
      return paneTabId;
    }
  }

  const topTab = createUserTab(
    worktreePath,
    "agent",
    initialPrompt,
    initialAgent,
  );
  uiState.updateWorktreeNavState(worktreePath, { activeTab: "terminal" });
  return getPrimaryGroupTabId(topTab);
}

function getActivePaneContext(worktreePath: string): {
  nav: WorktreeNavState;
  tree: SplitNode;
  groupId: string;
  topTab: UserTab | null;
  isAgent: boolean;
} | null {
  const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
  if (nav.activeTerminalsTab === AGENT_PANE_ID) {
    return {
      nav,
      tree: getEffectiveAgentTabSplitTree(nav.agentTabSplitTree),
      groupId: getEffectiveAgentTabFocusedPaneId(
        nav.agentTabSplitTree,
        nav.agentTabFocusedPaneId,
      ),
      topTab: null,
      isAgent: true,
    };
  }
  const topTab = nav.userTabs.find((tab) => tab.id === nav.activeTerminalsTab);
  if (!topTab) return null;
  return {
    nav,
    tree: getEffectiveUserTabSplitTree(topTab),
    groupId: getEffectiveUserTabFocusedPaneId(topTab),
    topTab,
    isAgent: false,
  };
}

/** True once the active top-level tab has a real pane/group context. */
export function shouldCreateTabInFocusedPane(worktreePath: string): boolean {
  const context = getActivePaneContext(worktreePath);
  if (!context) return false;
  // The first pane uses the top-level Run / Agent / user-tab strip as its
  // native tab bar. Cmd+T there should therefore keep creating top-level
  // tabs; only secondary split panes own group-local tabs.
  if (getLeaves(context.tree)[0]?.id === context.groupId) return false;
  return shouldUseGroupTabs(context.tree, context.groupId);
}

/** Cycle inner tabs in the focused pane; false means callers should cycle top-level tabs. */
export function focusAdjacentActiveGroupTab(
  worktreePath: string,
  direction: 1 | -1,
): boolean {
  const context = getActivePaneContext(worktreePath);
  if (!context) return false;
  if (getLeaves(context.tree)[0]?.id === context.groupId) return false;
  const group = findLeaf(context.tree, context.groupId);
  if (!group) return false;
  const nextId = getAdjacentGroupTabId(group, direction);
  if (!nextId) return false;
  if (context.isAgent) {
    setAgentGroupActiveTab(worktreePath, group.id, nextId);
  } else {
    setUserGroupActiveTab(worktreePath, context.topTab!.id, group.id, nextId);
  }
  return true;
}

export function setUserGroupActiveTab(
  worktreePath: string,
  topTabId: string,
  groupId: string,
  groupTabId: string,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const topTab = nav.userTabs.find((tab) => tab.id === topTabId);
  if (!topTab) return;
  const tree = setActiveGroupTab(
    getEffectiveUserTabSplitTree(topTab),
    groupId,
    groupTabId,
  );
  uiState.updateWorktreeNavState(worktreePath, {
    userTabs: nav.userTabs.map((tab) =>
      tab.id === topTabId ? { ...tab, splitTree: tree, focusedPaneId: groupId } : tab,
    ),
  });
}

export function setAgentGroupActiveTab(
  worktreePath: string,
  groupId: string,
  groupTabId: string,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  uiState.updateWorktreeNavState(worktreePath, {
    agentTabSplitTree: setActiveGroupTab(
      getEffectiveAgentTabSplitTree(nav.agentTabSplitTree),
      groupId,
      groupTabId,
    ),
    agentTabFocusedPaneId: groupId,
  });
}

function userKindForContent(content: PaneContent): UserTab["kind"] {
  return content.kind === "shell" ? "terminal" : content.kind;
}

function withPrimaryContent(tab: UserTab, tree: SplitNode): UserTab {
  const primaryTab = getActiveGroupTab(getLeaves(tree)[0]);
  const primary = primaryTab.content;
  const {
    path: _path,
    url: _url,
    pinned: _pinned,
    ...rest
  } = tab;
  return {
    ...rest,
    kind: userKindForContent(primary),
    label: primaryTab.label,
    ...(primary.kind === "file"
      ? { path: primary.path, ...(primaryTab.pinned ? { pinned: true } : {}) }
      : {}),
    ...(primary.kind === "browser" ? { url: primary.url } : {}),
    splitTree: tree,
  };
}

// Tear down one pane's resource by content kind: kill its PTY for
// terminal/agent leaves, close the native webview for a browser leaf. File
// leaves need no teardown. Also drops any pending agent-launch handoff.
function disposeGroupTab(
  worktreePath: string,
  tab: GroupTab,
): void {
  clearPendingAgentLaunch(tab.id);
  if (tab.content.kind === "browser") {
    invoke("browser_close", { id: tab.id }).catch(() => {});
  } else if (tab.content.kind === "agent" || tab.content.kind === "shell") {
    killPaneSession(worktreePath, tab.id);
  } else if (tab.content.kind === "file") {
    useEditorDocsStore
      .getState()
      .removeDoc(buildDocumentKey(worktreePath, tab.content.path));
  }
}

function confirmGroupTabClose(worktreePath: string, tab: GroupTab): boolean {
  if (tab.content.kind !== "file") return true;
  const doc = useEditorDocsStore.getState().docs[
    buildDocumentKey(worktreePath, tab.content.path)
  ];
  return !doc?.dirty || window.confirm(
    `${tab.content.path} has unsaved changes. Discard them?`,
  );
}

// Persist a divider drag inside a user tab's split tree. `splitId` identifies
// the split (see `updateRatio`); no-op when the tab has no tree yet.
export function updateUserTabRatio(
  worktreePath: string,
  tabId: string,
  splitId: string,
  ratio: number,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tab = nav.userTabs.find((t) => t.id === tabId);
  if (!tab) return;

  const tree = getEffectiveUserTabSplitTree(tab);
  const nextTree = updateRatio(tree, splitId, ratio);

  const nextTabs = nav.userTabs.map((t) =>
    t.id === tabId ? { ...t, splitTree: nextTree } : t,
  );
  uiState.updateWorktreeNavState(worktreePath, { userTabs: nextTabs });
}

// Persist a browser pane's current URL onto its leaf content (the source of
// truth), mirroring to `tab.url` when it's a user tab's primary leaf. Called
// from BrowserPane on navigation events. `tabId === AGENT_PANE_ID` routes to
// the agent system tab's tree. No-op if the leaf isn't a browser leaf.
export function setBrowserLeafUrl(
  worktreePath: string,
  tabId: string,
  paneId: string,
  url: string,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);

  if (tabId === AGENT_PANE_ID) {
    const nextTree = updateLeafContent(
      getEffectiveAgentTabSplitTree(nav.agentTabSplitTree),
      paneId,
      (c) => (c.kind === "browser" ? { ...c, url } : c),
    );
    uiState.updateWorktreeNavState(worktreePath, { agentTabSplitTree: nextTree });
    return;
  }

  const tab = nav.userTabs.find((t) => t.id === tabId);
  if (!tab) return;

  const nextTree = updateLeafContent(
    getEffectiveUserTabSplitTree(tab),
    paneId,
    (c) => (c.kind === "browser" ? { ...c, url } : c),
  );
  const isPrimary = paneId === getPrimaryGroupTabId(tab);
  const nextTabs = nav.userTabs.map((t) =>
    t.id === tabId
      ? { ...t, splitTree: nextTree, ...(isPrimary ? { url } : {}) }
      : t,
  );
  uiState.updateWorktreeNavState(worktreePath, { userTabs: nextTabs });
}

// The current persisted URL of a browser pane, read from its leaf content.
// `tabId === AGENT_PANE_ID` reads the agent system tab's tree. Used by
// BrowserPane's omnibox to recover the live URL on blur.
export function getBrowserLeafUrl(
  worktreePath: string,
  tabId: string,
  paneId: string,
): string | undefined {
  const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
  const tree =
    tabId === AGENT_PANE_ID
      ? getEffectiveAgentTabSplitTree(nav.agentTabSplitTree)
      : (() => {
          const tab = nav.userTabs.find((t) => t.id === tabId);
          return tab ? getEffectiveUserTabSplitTree(tab) : null;
        })();
  if (!tree) return undefined;
  const found = findGroupTab(tree, paneId);
  return found?.tab.content.kind === "browser" ? found.tab.content.url : undefined;
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
  const focusedId = getEffectiveUserTabFocusedPaneId(tab);
  const focusedGroup = findLeaf(tree, focusedId);
  if (!focusedGroup) return;
  const activeGroupTab = getActiveGroupTab(focusedGroup);

  if (focusedGroup.tabs.length === 1 && getLeaves(tree).length <= 1) {
    closeUserTab(worktreePath, tabId);
    return;
  }

  if (focusedGroup.tabs.length > 1) {
    if (!confirmGroupTabClose(worktreePath, activeGroupTab)) return;
    const result = removeGroupTab(tree, focusedId, activeGroupTab.id);
    disposeGroupTab(worktreePath, activeGroupTab);
    const nextTree = result.tree!;
    uiState.updateWorktreeNavState(worktreePath, {
      userTabs: nav.userTabs.map((candidate) =>
        candidate.id === tabId ? withPrimaryContent(candidate, nextTree) : candidate,
      ),
    });
    return;
  }

  const adjacentId = getAdjacentLeafId(tree, focusedId, -1);
  if (!confirmGroupTabClose(worktreePath, activeGroupTab)) return;
  const newTree = removeNode(tree, focusedId)!;
  disposeGroupTab(worktreePath, activeGroupTab);

  const nextTabs = nav.userTabs.map((t) =>
    t.id === tabId
      ? { ...withPrimaryContent(t, newTree), focusedPaneId: adjacentId }
      : t,
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

// --- Agent system tab split ---
// The Agent tab is synthesized (no UserTab record), so its split state lives
// directly on the nav state. The root leaf keeps id AGENT_PANE_ID so the
// primary agent's PTY session is unchanged; the Run tab stays unsplittable.

export function getEffectiveAgentTabSplitTree(
  splitTree: SplitNode | undefined,
): SplitNode {
  if (splitTree) return normalizeLegacySplitTree(splitTree, { kind: "agent" });
  return singleGroup(AGENT_PANE_ID, { kind: "agent" }, "Agent");
}

export function getEffectiveAgentTabFocusedPaneId(
  splitTree: SplitNode | undefined,
  focusedPaneId: string | undefined,
): string {
  const tree = getEffectiveAgentTabSplitTree(splitTree);
  if (focusedPaneId && findLeaf(tree, focusedPaneId)) return focusedPaneId;
  return getLeaves(tree)[0]?.id ?? AGENT_PANE_ID;
}

export function splitAgentTabPane(
  worktreePath: string,
  orientation: "horizontal" | "vertical",
  content: PaneContent = { kind: "shell" },
): string | null {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tree = getEffectiveAgentTabSplitTree(nav.agentTabSplitTree);
  const focusedId = getEffectiveAgentTabFocusedPaneId(
    nav.agentTabSplitTree,
    nav.agentTabFocusedPaneId,
  );
  const result = splitNode(tree, focusedId, orientation, content);
  if (!result) return null;
  uiState.updateWorktreeNavState(worktreePath, {
    agentTabSplitTree: result.tree,
    agentTabFocusedPaneId: result.newLeafId,
  });
  return result.newLeafId;
}

export function updateAgentTabRatio(
  worktreePath: string,
  splitId: string,
  ratio: number,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tree = getEffectiveAgentTabSplitTree(nav.agentTabSplitTree);
  uiState.updateWorktreeNavState(worktreePath, {
    agentTabSplitTree: updateRatio(tree, splitId, ratio),
  });
}

// Removes the focused pane; the Agent tab itself is never closed (system tab),
// so a single-leaf tree is a no-op.
export function closeAgentTabFocusedPane(worktreePath: string): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tree = getEffectiveAgentTabSplitTree(nav.agentTabSplitTree);
  const focusedId = getEffectiveAgentTabFocusedPaneId(
    nav.agentTabSplitTree,
    nav.agentTabFocusedPaneId,
  );
  const focusedGroup = findLeaf(tree, focusedId);
  if (!focusedGroup) return;
  const activeGroupTab = getActiveGroupTab(focusedGroup);
  const totalTabs = getLeaves(tree).reduce(
    (total, group) => total + group.tabs.length,
    0,
  );

  // The system tab itself survives its last inner tab. If its primary Agent
  // was closed earlier, closing the final remaining tab restores that Agent.
  if (totalTabs === 1) {
    if (activeGroupTab.id === AGENT_PANE_ID) return;
    if (!confirmGroupTabClose(worktreePath, activeGroupTab)) return;
    disposeGroupTab(worktreePath, activeGroupTab);
    uiState.updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: singleGroup(AGENT_PANE_ID, { kind: "agent" }, "Agent"),
      agentTabFocusedPaneId: AGENT_PANE_ID,
    });
    return;
  }

  if (focusedGroup.tabs.length > 1) {
    if (!confirmGroupTabClose(worktreePath, activeGroupTab)) return;
    const result = removeGroupTab(tree, focusedId, activeGroupTab.id);
    disposeGroupTab(worktreePath, activeGroupTab);
    uiState.updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: result.tree!,
      agentTabFocusedPaneId: focusedId,
    });
    return;
  }

  if (!confirmGroupTabClose(worktreePath, activeGroupTab)) return;
  const adjacentId = getAdjacentLeafId(tree, focusedId, -1);
  const newTree = removeNode(tree, focusedId)!;
  disposeGroupTab(worktreePath, activeGroupTab);

  uiState.updateWorktreeNavState(worktreePath, {
    agentTabSplitTree: newTree,
    agentTabFocusedPaneId: adjacentId,
  });
}

export function focusAdjacentAgentTabPane(
  worktreePath: string,
  direction: 1 | -1,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const tree = getEffectiveAgentTabSplitTree(nav.agentTabSplitTree);
  if (getLeaves(tree).length <= 1) return;

  const focusedId = getEffectiveAgentTabFocusedPaneId(
    nav.agentTabSplitTree,
    nav.agentTabFocusedPaneId,
  );
  const nextId = getAdjacentLeafId(tree, focusedId, direction);
  if (nextId === focusedId) return;
  uiState.updateWorktreeNavState(worktreePath, { agentTabFocusedPaneId: nextId });
}

export function setAgentTabFocusedPane(
  worktreePath: string,
  paneId: string,
): void {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  if (nav.agentTabFocusedPaneId === paneId) return;
  uiState.updateWorktreeNavState(worktreePath, { agentTabFocusedPaneId: paneId });
}

export interface OpenFileTabOptions {
  pin?: boolean;
  /**
   * When true, skip the preview-retarget branch and always create a fresh
   * tab (unless a tab for this exact path already exists, in which case the
   * existing tab is activated). Useful for actions that should never
   * clobber the current preview, e.g. clicking a markdown link.
   */
  forceNewTab?: boolean;
  line?: number;
  col?: number;
}

/**
 * Open a file in the dynamic tab bar with VS Code preview/pin semantics.
 *
 * - If a tab for this exact path already exists, just activate it (matches
 *   pinned tabs always; matches the preview tab only when `forceNewTab` is set
 *   so we don't open a duplicate of what's already showing).
 * - Else if `forceNewTab` is false and a preview tab exists, retarget its
 *   path; do not create a new tab. If `pin` is true, the preview is promoted
 *   to pinned at the same time.
 * - Otherwise create a fresh tab (preview unless `pin` is true).
 *
 * If `line` is provided, the line-jump target is parked on the editor-docs
 * store and consumed by FileViewer once the editor mounts.
 */
export function openFileTab(
  worktreePath: string,
  path: string,
  opts: OpenFileTabOptions = {},
): UserTab {
  const { pin = false, forceNewTab = false, line, col } = opts;
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const label = basename(path);

  // Only force the top-level tab area to "terminal" when the user is on the
  // diff view (where TabbedTerminals isn't visible); the terminal view already
  // shows terminal content, so flipping it would collapse the user's layout.
  const needsTabAreaSwitch = nav.activeTab === "diff";

  const parkPendingTarget = (): void => {
    if (line === undefined) return;
    useEditorDocsStore
      .getState()
      .setPendingTarget(buildDocumentKey(worktreePath, path), { line, col });
  };

  // Tab for this exact path already exists — just activate it. Pinned tabs
  // always match; the unpinned preview only matches when forceNewTab is set
  // (so a regular FilesPanel click can still retarget the preview to itself).
  const existing = nav.userTabs.find(
    (t) =>
      t.kind === "file" &&
      t.path === path &&
      (t.pinned || forceNewTab),
  );
  if (existing) {
    const updates: Partial<WorktreeNavState> = {
      activeTerminalsTab: existing.id,
    };
    if (needsTabAreaSwitch) updates.activeTab = "terminal";
    uiState.updateWorktreeNavState(worktreePath, updates);
    parkPendingTarget();
    uiState.revealFileInTree(worktreePath, path);
    return existing;
  }

  const previewTab = !forceNewTab
    ? nav.userTabs.find((t) => t.kind === "file" && !t.pinned)
    : undefined;

  if (previewTab) {
    // Retarget the preview's primary file tab to the new path and label
    // (source of truth), keeping the top-level mirrors in step.
    const nextTree = updateGroupTab(
      getEffectiveUserTabSplitTree(previewTab),
      getPrimaryGroupTabId(previewTab),
      (groupTab) => ({
        ...groupTab,
        label,
        pinned: pin || groupTab.pinned,
        content:
          groupTab.content.kind === "file"
            ? { ...groupTab.content, path }
            : groupTab.content,
      }),
    );
    const updated: UserTab = {
      ...previewTab,
      path,
      label,
      pinned: pin || previewTab.pinned,
      splitTree: nextTree,
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
    parkPendingTarget();
    uiState.revealFileInTree(worktreePath, path);
    return updated;
  }

  // No preview tab; create one.
  const tabId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rootLeaf = singleGroup(
    userTabPaneId(tabId),
    { kind: "file", path },
    label,
    pin,
  );
  const newTab: UserTab = {
    id: tabId,
    kind: "file",
    label,
    createdAt: Date.now(),
    path,
    pinned: pin,
    splitTree: rootLeaf,
    focusedPaneId: rootLeaf.id,
  };
  const updates: Partial<WorktreeNavState> = {
    userTabs: [...nav.userTabs, newTab],
    activeTerminalsTab: tabId,
  };
  if (needsTabAreaSwitch) updates.activeTab = "terminal";
  uiState.updateWorktreeNavState(worktreePath, updates);
  parkPendingTarget();
  uiState.revealFileInTree(worktreePath, path);
  return newTab;
}
