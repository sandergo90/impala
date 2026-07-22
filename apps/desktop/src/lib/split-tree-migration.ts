import { userTabPaneId } from "./pane-ids";

function migrateLegacyLeaves(node: any): any {
  if (!node || typeof node !== "object") return node;
  if (node.type === "leaf") {
    if (node.content) return node;
    const content =
      node.paneType === "agent" ? { kind: "agent" } : { kind: "shell" };
    const { paneType: _paneType, ...rest } = node;
    return { ...rest, content };
  }
  return {
    ...node,
    first: migrateLegacyLeaves(node.first),
    second: migrateLegacyLeaves(node.second),
  };
}

/** Upgrade the persisted v6 user-tab shape to content-bearing v7 leaves. */
export function migrateUserTabsToV7(userTabs: any[]): any[] {
  return userTabs.map((tab) => {
    const primaryLeafId = userTabPaneId(tab.id);
    let splitTree: any;
    if (tab.splitTree) {
      splitTree = migrateLegacyLeaves(tab.splitTree);
    } else {
      let content: any;
      if (tab.kind === "file")
        content = { kind: "file", path: tab.path ?? "" };
      else if (tab.kind === "browser")
        content = { kind: "browser", url: tab.url };
      else if (tab.kind === "agent") content = { kind: "agent" };
      else content = { kind: "shell" };
      splitTree = { type: "leaf", id: primaryLeafId, content };
    }
    return {
      ...tab,
      splitTree,
      focusedPaneId: tab.focusedPaneId ?? primaryLeafId,
    };
  });
}

export function migrateSplitTreeToV8(node: any): any {
  if (!node || typeof node !== "object") return node;
  if (node.type === "group") return node;
  if (node.type === "leaf") {
    const {
      type: _type,
      id,
      content,
      paneType: _paneType,
      ...unknownFields
    } = node;
    const tab = {
      id,
      label:
        content?.kind === "agent" ? "Agent" :
        content?.kind === "shell" ? "Terminal" :
        content?.kind === "file" ? content.path?.split("/").pop() || content.path :
        "Browser",
      content,
      createdAt: 0,
    };
    return {
      ...unknownFields,
      type: "group",
      id,
      tabs: [tab],
      activeTabId: tab.id,
    };
  }
  return {
    ...node,
    first: migrateSplitTreeToV8(node.first),
    second: migrateSplitTreeToV8(node.second),
  };
}

export function migrateUserTabsToV8(userTabs: any[]): any[] {
  return userTabs.map((tab) => {
    const primaryTabId = userTabPaneId(tab.id);
    const enrichPrimaryTab = (node: any): any => {
      if (!node || typeof node !== "object") return node;
      if (node.type === "group") {
        if (!node.tabs?.some((groupTab: any) => groupTab.id === primaryTabId)) {
          return node;
        }
        return {
          ...node,
          tabs: node.tabs.map((groupTab: any) =>
            groupTab.id === primaryTabId
              ? {
                  ...groupTab,
                  label: tab.label ?? groupTab.label,
                  createdAt: tab.createdAt ?? groupTab.createdAt,
                  ...(tab.pinned === undefined ? {} : { pinned: tab.pinned }),
                }
              : groupTab,
          ),
        };
      }
      return {
        ...node,
        first: enrichPrimaryTab(node.first),
        second: enrichPrimaryTab(node.second),
      };
    };

    const splitTree = tab.splitTree
      ? enrichPrimaryTab(migrateSplitTreeToV8(tab.splitTree))
      : tab.splitTree;
    return { ...tab, splitTree };
  });
}
