import type { GroupTab, PaneContent, SplitNode } from "../types";

export type SplitGroup = Extract<SplitNode, { type: "group" }>;

function defaultLabel(content: PaneContent): string {
  switch (content.kind) {
    case "terminal": return content.launch === "agent" ? "Agent" : "Terminal";
    case "file": return content.path.split("/").pop() || content.path;
    case "browser": return "Browser";
  }
}

function isCurrentPaneContent(content: unknown): content is PaneContent {
  const value = content as any;
  return (
    (value?.kind === "terminal" &&
      (value.launch === "shell" || value.launch === "agent")) ||
    (value?.kind === "file" && typeof value.path === "string") ||
    (value?.kind === "browser" &&
      (value.url === undefined || typeof value.url === "string"))
  );
}

export function normalizePaneContent(
  value: unknown,
  fallback: PaneContent = { kind: "terminal", launch: "shell" },
): PaneContent {
  const content = value as any;
  if (content?.kind === "terminal") {
    return {
      kind: "terminal",
      launch: content.launch === "agent" ? "agent" : "shell",
    };
  }
  if (content?.kind === "agent") return { kind: "terminal", launch: "agent" };
  if (content?.kind === "shell") return { kind: "terminal", launch: "shell" };
  if (content?.kind === "file" && typeof content.path === "string") {
    return { kind: "file", path: content.path };
  }
  if (content?.kind === "browser") {
    return {
      kind: "browser",
      ...(typeof content.url === "string" ? { url: content.url } : {}),
    };
  }
  return fallback;
}

export function createGroupTab(
  id: string,
  content: PaneContent,
  label = defaultLabel(content),
): GroupTab {
  return { id, label, content, createdAt: Date.now() };
}

/** Normalize pre-v8 leaf trees and hot-reloaded legacy paneType trees. */
export function normalizeSplitTree(
  value: unknown,
  fallbackContent: PaneContent = { kind: "terminal", launch: "shell" },
): SplitNode {
  const node = value as any;
  if (node?.type === "group" && typeof node.id === "string") {
    return {
      ...node,
      tabs: Array.isArray(node.tabs)
        ? node.tabs.map((tab: any) =>
            isCurrentPaneContent(tab.content)
              ? tab
              : {
                  ...tab,
                  content: normalizePaneContent(tab.content, fallbackContent),
                },
          )
        : [],
    };
  }
  if (node?.type === "leaf" && typeof node.id === "string") {
    const content = normalizePaneContent(
      node.content ??
        (node.paneType === "agent"
          ? { kind: "agent" }
          : node.paneType === "shell"
            ? { kind: "shell" }
            : fallbackContent),
      fallbackContent,
    );
    const tab = createGroupTab(node.id, content);
    return { type: "group", id: node.id, tabs: [tab], activeTabId: tab.id };
  }
  if (
    node?.type === "split" &&
    (node.orientation === "horizontal" || node.orientation === "vertical") &&
    typeof node.ratio === "number"
  ) {
    return {
      type: "split",
      orientation: node.orientation,
      ratio: node.ratio,
      first: normalizeSplitTree(node.first, fallbackContent),
      second: normalizeSplitTree(node.second, fallbackContent),
    };
  }
  throw new Error("Invalid split tree");
}

/** Backward-compatible name used at existing runtime boundaries. */
export const normalizeLegacySplitTree = normalizeSplitTree;

let paneCounter = 0;

export function paneSessionId(paneId: string): string {
  return `pty-${paneId}`;
}

export function createGroup(
  content: PaneContent = { kind: "terminal", launch: "shell" },
): SplitGroup {
  const id = `pane-${Date.now()}-${paneCounter++}`;
  const tab = createGroupTab(id, content);
  return { type: "group", id, tabs: [tab], activeTabId: tab.id };
}

/** Compatibility alias for callers creating a single content-bearing pane. */
export const createLeaf = createGroup;

export function getGroups(node: SplitNode): SplitGroup[] {
  if (node.type === "group") return [node];
  return [...getGroups(node.first), ...getGroups(node.second)];
}

export const getLeaves = getGroups;

export function findGroup(node: SplitNode, id: string): SplitGroup | null {
  if (node.type === "group") return node.id === id ? node : null;
  return findGroup(node.first, id) ?? findGroup(node.second, id);
}

export const findLeaf = findGroup;

export function getActiveGroupTab(group: SplitGroup): GroupTab {
  return group.tabs.find((tab) => tab.id === group.activeTabId) ?? group.tabs[0];
}

export function shouldUseGroupTabs(tree: SplitNode, groupId: string): boolean {
  const group = findGroup(tree, groupId);
  return getGroups(tree).length > 1 || (group?.tabs.length ?? 0) > 1;
}

export function getAdjacentGroupTabId(
  group: SplitGroup,
  direction: 1 | -1,
): string | null {
  if (group.tabs.length <= 1) return null;
  const currentIndex = group.tabs.findIndex((tab) => tab.id === group.activeTabId);
  return group.tabs[
    (Math.max(currentIndex, 0) + direction + group.tabs.length) % group.tabs.length
  ].id;
}

export function findGroupTab(
  tree: SplitNode,
  tabId: string,
): { group: SplitGroup; tab: GroupTab } | null {
  for (const group of getGroups(tree)) {
    const tab = group.tabs.find((candidate) => candidate.id === tabId);
    if (tab) return { group, tab };
  }
  return null;
}

export function splitNode(
  tree: SplitNode,
  targetId: string,
  orientation: "horizontal" | "vertical",
  content: PaneContent = { kind: "terminal", launch: "shell" },
): { tree: SplitNode; newLeafId: string } | null {
  const newGroup = createGroup(content);
  const replaced = replaceNode(tree, targetId, (group) => ({
    type: "split",
    orientation,
    ratio: 0.5,
    first: group,
    second: newGroup,
  }));
  return replaced ? { tree: replaced, newLeafId: newGroup.id } : null;
}

export function removeNode(tree: SplitNode, targetId: string): SplitNode | null {
  if (tree.type === "group") return tree.id === targetId ? null : tree;
  if (tree.first.type === "group" && tree.first.id === targetId) return tree.second;
  if (tree.second.type === "group" && tree.second.id === targetId) return tree.first;
  const newFirst = removeNode(tree.first, targetId);
  if (newFirst !== tree.first) {
    return newFirst === null ? tree.second : { ...tree, first: newFirst };
  }
  const newSecond = removeNode(tree.second, targetId);
  if (newSecond !== tree.second) {
    return newSecond === null ? tree.first : { ...tree, second: newSecond };
  }
  return tree;
}

export function getAdjacentLeafId(
  tree: SplitNode,
  currentId: string,
  direction: 1 | -1,
): string {
  const groups = getGroups(tree);
  const idx = groups.findIndex((group) => group.id === currentId);
  if (idx === -1) return groups[0]?.id ?? currentId;
  return groups[(idx + direction + groups.length) % groups.length].id;
}

type PaneBounds = {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function collectPaneBounds(
  node: SplitNode,
  bounds: Omit<PaneBounds, "id">,
): PaneBounds[] {
  if (node.type === "group") return [{ id: node.id, ...bounds }];

  if (node.orientation === "vertical") {
    const divider = bounds.left + (bounds.right - bounds.left) * node.ratio;
    return [
      ...collectPaneBounds(node.first, { ...bounds, right: divider }),
      ...collectPaneBounds(node.second, { ...bounds, left: divider }),
    ];
  }

  const divider = bounds.top + (bounds.bottom - bounds.top) * node.ratio;
  return [
    ...collectPaneBounds(node.first, { ...bounds, bottom: divider }),
    ...collectPaneBounds(node.second, { ...bounds, top: divider }),
  ];
}

/** Find the nearest pane that is geometrically left or right of a pane. */
export function getHorizontalNeighborGroupId(
  tree: SplitNode,
  groupId: string,
  direction: "left" | "right",
): string | null {
  const panes = collectPaneBounds(tree, {
    left: 0,
    right: 1,
    top: 0,
    bottom: 1,
  });
  const current = panes.find((pane) => pane.id === groupId);
  if (!current) return null;

  const epsilon = 1e-9;
  const candidates = panes
    .filter((pane) => {
      const verticalOverlap =
        Math.min(current.bottom, pane.bottom) - Math.max(current.top, pane.top);
      if (verticalOverlap <= epsilon) return false;
      return direction === "right"
        ? pane.left >= current.right - epsilon
        : pane.right <= current.left + epsilon;
    })
    .map((pane) => ({
      pane,
      gap:
        direction === "right"
          ? pane.left - current.right
          : current.left - pane.right,
      overlap:
        Math.min(current.bottom, pane.bottom) - Math.max(current.top, pane.top),
      centerDistance: Math.abs(
        (pane.top + pane.bottom) / 2 - (current.top + current.bottom) / 2,
      ),
    }))
    .sort(
      (a, b) =>
        a.gap - b.gap ||
        b.overlap - a.overlap ||
        a.centerDistance - b.centerDistance,
    );

  return candidates[0]?.pane.id ?? null;
}

export function updateRatio(tree: SplitNode, splitId: string, ratio: number): SplitNode {
  if (tree.type === "group") return tree;
  if (getGroups(tree.second)[0]?.id === splitId) return { ...tree, ratio };
  return {
    ...tree,
    first: updateRatio(tree.first, splitId, ratio),
    second: updateRatio(tree.second, splitId, ratio),
  };
}

export function updateGroup(
  tree: SplitNode,
  groupId: string,
  update: (group: SplitGroup) => SplitGroup,
): SplitNode {
  if (tree.type === "group") return tree.id === groupId ? update(tree) : tree;
  return {
    ...tree,
    first: updateGroup(tree.first, groupId, update),
    second: updateGroup(tree.second, groupId, update),
  };
}

export function updateLeafContent(
  tree: SplitNode,
  tabId: string,
  update: (content: PaneContent) => PaneContent,
): SplitNode {
  const found = findGroupTab(tree, tabId);
  if (!found) return tree;
  return updateGroup(tree, found.group.id, (group) => ({
    ...group,
    tabs: group.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, content: update(tab.content) } : tab,
    ),
  }));
}

/**
 * Open a URL in another pane. Reuse its browser tab when possible; otherwise
 * add a browser tab to an existing split pane. Only create a new right split
 * when the source is the sole pane. Browser tabs in the source group do not
 * count because activating one would replace the terminal the user clicked.
 */
export function openUrlInBrowserSplit(
  tree: SplitNode,
  sourceGroupId: string,
  url: string,
): {
  tree: SplitNode;
  browserGroupId: string;
  browserTabId: string;
  created: boolean;
} | null {
  const browserGroup = getGroups(tree).find(
    (group) =>
      group.id !== sourceGroupId &&
      getActiveGroupTab(group)?.content.kind === "browser",
  );
  if (browserGroup) {
    const browserTab = getActiveGroupTab(browserGroup);
    return {
      tree: updateLeafContent(tree, browserTab.id, (content) =>
        content.kind === "browser" ? { ...content, url } : content,
      ),
      browserGroupId: browserGroup.id,
      browserTabId: browserTab.id,
      created: false,
    };
  }

  const groups = getGroups(tree);
  const hiddenBrowser = groups
    .filter((group) => group.id !== sourceGroupId)
    .flatMap((group) =>
      group.tabs
        .filter((tab) => tab.content.kind === "browser")
        .map((tab) => ({ group, tab })),
    )[0];
  if (hiddenBrowser) {
    const nextTree = setActiveGroupTab(
      updateLeafContent(tree, hiddenBrowser.tab.id, (content) =>
        content.kind === "browser" ? { ...content, url } : content,
      ),
      hiddenBrowser.group.id,
      hiddenBrowser.tab.id,
    );
    return {
      tree: nextTree,
      browserGroupId: hiddenBrowser.group.id,
      browserTabId: hiddenBrowser.tab.id,
      created: false,
    };
  }

  const targetGroupId =
    getHorizontalNeighborGroupId(tree, sourceGroupId, "right") ??
    groups.find((group) => group.id !== sourceGroupId)?.id;
  if (targetGroupId) {
    const browserTab = createGroup({ kind: "browser", url }).tabs[0];
    return {
      tree: addTabToGroup(tree, targetGroupId, browserTab),
      browserGroupId: targetGroupId,
      browserTabId: browserTab.id,
      created: true,
    };
  }

  const result = splitNode(tree, sourceGroupId, "vertical", {
    kind: "browser",
    url,
  });
  if (!result) return null;
  const newGroup = findGroup(result.tree, result.newLeafId);
  const browserTab = newGroup ? getActiveGroupTab(newGroup) : null;
  if (!browserTab) return null;
  return {
    tree: result.tree,
    browserGroupId: result.newLeafId,
    browserTabId: browserTab.id,
    created: true,
  };
}

export function updateGroupTab(
  tree: SplitNode,
  tabId: string,
  update: (tab: GroupTab) => GroupTab,
): SplitNode {
  const found = findGroupTab(tree, tabId);
  if (!found) return tree;
  return updateGroup(tree, found.group.id, (group) => ({
    ...group,
    tabs: group.tabs.map((tab) => (tab.id === tabId ? update(tab) : tab)),
  }));
}

export function addTabToGroup(
  tree: SplitNode,
  groupId: string,
  tab: GroupTab,
): SplitNode {
  return insertGroupTab(tree, groupId, tab);
}

/** Insert an existing tab into a group without changing its identity. */
export function insertGroupTab(
  tree: SplitNode,
  groupId: string,
  tab: GroupTab,
  index?: number,
): SplitNode {
  if (findGroupTab(tree, tab.id) || !findGroup(tree, groupId)) return tree;
  return updateGroup(tree, groupId, (group) => {
    const tabs = [...group.tabs];
    const insertionIndex = Math.max(0, Math.min(index ?? tabs.length, tabs.length));
    tabs.splice(insertionIndex, 0, tab);
    return { ...group, tabs, activeTabId: tab.id };
  });
}

export type PaneEdge = "left" | "right" | "top" | "bottom";

/** Split a pane at an edge and place an existing tab in the new sibling group. */
export function insertGroupAtEdge(
  tree: SplitNode,
  targetGroupId: string,
  edge: PaneEdge,
  tab: GroupTab,
): SplitNode {
  if (findGroupTab(tree, tab.id) || !findGroup(tree, targetGroupId)) return tree;

  const groupId = `pane-${Date.now()}-${paneCounter++}`;
  const newGroup: SplitGroup = {
    type: "group",
    id: groupId,
    tabs: [tab],
    activeTabId: tab.id,
  };
  const orientation = edge === "left" || edge === "right"
    ? "vertical"
    : "horizontal";
  const newGroupFirst = edge === "left" || edge === "top";
  return replaceNode(tree, targetGroupId, (target) => ({
    type: "split",
    orientation,
    ratio: 0.5,
    first: newGroupFirst ? newGroup : target,
    second: newGroupFirst ? target : newGroup,
  })) ?? tree;
}

export function setActiveGroupTab(
  tree: SplitNode,
  groupId: string,
  tabId: string,
): SplitNode {
  return updateGroup(tree, groupId, (group) =>
    group.tabs.some((tab) => tab.id === tabId)
      ? { ...group, activeTabId: tabId }
      : group,
  );
}

export function removeGroupTab(
  tree: SplitNode,
  groupId: string,
  tabId: string,
): { tree: SplitNode | null; removed: GroupTab | null } {
  const group = findGroup(tree, groupId);
  const removed = group?.tabs.find((tab) => tab.id === tabId) ?? null;
  if (!group || !removed) return { tree, removed: null };
  if (group.tabs.length === 1) return { tree: removeNode(tree, groupId), removed };
  const index = group.tabs.indexOf(removed);
  const remaining = group.tabs.filter((tab) => tab.id !== tabId);
  const activeTabId = group.activeTabId === tabId
    ? remaining[Math.min(index, remaining.length - 1)].id
    : group.activeTabId;
  return {
    tree: updateGroup(tree, groupId, (current) => ({
      ...current,
      tabs: remaining,
      activeTabId,
    })),
    removed,
  };
}

/** Extract a tab while leaving its backing PTY, webview, or editor buffer untouched. */
export function extractGroupTab(
  tree: SplitNode,
  groupId: string,
  tabId: string,
): { tree: SplitNode | null; tab: GroupTab | null } {
  const result = removeGroupTab(tree, groupId, tabId);
  return { tree: result.tree, tab: result.removed };
}

/** Move a tab within or between groups, collapsing an emptied source group. */
export function moveGroupTab(
  tree: SplitNode,
  sourceGroupId: string,
  tabId: string,
  targetGroupId: string,
  index?: number,
): SplitNode {
  const source = findGroup(tree, sourceGroupId);
  const target = findGroup(tree, targetGroupId);
  const tab = source?.tabs.find((candidate) => candidate.id === tabId);
  if (!source || !target || !tab) return tree;

  if (sourceGroupId === targetGroupId) {
    const fromIndex = source.tabs.indexOf(tab);
    const toIndex = Math.max(
      0,
      Math.min(index ?? source.tabs.length - 1, source.tabs.length - 1),
    );
    if (fromIndex === toIndex) return tree;
    return updateGroup(tree, sourceGroupId, (group) => {
      const tabs = [...group.tabs];
      tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, tab);
      return { ...group, tabs, activeTabId: tab.id };
    });
  }

  const extracted = extractGroupTab(tree, sourceGroupId, tabId);
  if (!extracted.tree || !extracted.tab) return tree;
  return insertGroupTab(extracted.tree, targetGroupId, extracted.tab, index);
}

export function reorderGroupTabs(
  tree: SplitNode,
  groupId: string,
  tabId: string,
  index: number,
): SplitNode {
  return moveGroupTab(tree, groupId, tabId, groupId, index);
}

function replaceNode(
  tree: SplitNode,
  targetId: string,
  transform: (group: SplitGroup) => SplitNode,
): SplitNode | null {
  if (tree.type === "group") return tree.id === targetId ? transform(tree) : null;
  const first = replaceNode(tree.first, targetId, transform);
  if (first) return { ...tree, first };
  const second = replaceNode(tree.second, targetId, transform);
  return second ? { ...tree, second } : null;
}
