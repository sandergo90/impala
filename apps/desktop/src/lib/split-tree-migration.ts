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

function migratePaneContentToV10(content: any): any {
  if (content?.kind === "agent") return { kind: "terminal", launch: "agent" };
  if (content?.kind === "shell") return { kind: "terminal", launch: "shell" };
  if (content?.kind === "terminal") {
    return {
      ...content,
      launch: content.launch === "agent" ? "agent" : "shell",
    };
  }
  return content;
}

export function migrateSplitTreeToV10(node: any): any {
  if (!node || typeof node !== "object") return node;
  if (node.type === "group") {
    return {
      ...node,
      tabs: Array.isArray(node.tabs)
        ? node.tabs.map((tab: any) => ({
            ...tab,
            content: migratePaneContentToV10(tab.content),
          }))
        : node.tabs,
    };
  }
  return {
    ...node,
    first: migrateSplitTreeToV10(node.first),
    second: migrateSplitTreeToV10(node.second),
  };
}

export function migrateUserTabsToV10(userTabs: any[]): any[] {
  return userTabs.map((tab) => {
    const wasAgent = tab.kind === "agent";
    return {
      ...tab,
      kind: wasAgent ? "terminal" : tab.kind,
      ...(tab.kind === "terminal" || wasAgent
        ? {
            terminalLaunch:
              tab.terminalLaunch === "agent" || wasAgent ? "agent" : "shell",
          }
        : {}),
      splitTree: tab.splitTree
        ? migrateSplitTreeToV10(tab.splitTree)
        : tab.splitTree,
    };
  });
}

function hasAutomaticLabel(tab: any): boolean {
  const label = typeof tab?.label === "string" ? tab.label : "";
  const content = tab?.content;
  if (content?.kind === "file" || tab?.kind === "file") return true;
  if (content?.kind === "browser" || tab?.kind === "browser") {
    return /^Browser(?: \d+)?$/.test(label);
  }
  const launch = content?.launch ?? tab?.terminalLaunch;
  return launch === "agent"
    ? /^Agent(?: \d+)?$/.test(label)
    : /^Terminal(?: \d+)?$/.test(label);
}

export function migrateSplitTreeToV11(node: any): any {
  if (!node || typeof node !== "object") return node;
  if (node.type === "group") {
    return {
      ...node,
      tabs: Array.isArray(node.tabs)
        ? node.tabs.map((tab: any) =>
            tab?.userLabel || hasAutomaticLabel(tab)
              ? tab
              : { ...tab, userLabel: tab.label },
          )
        : node.tabs,
    };
  }
  return {
    ...node,
    first: migrateSplitTreeToV11(node.first),
    second: migrateSplitTreeToV11(node.second),
  };
}

export function migrateUserTabsToV11(userTabs: any[]): any[] {
  return userTabs.map((tab) => ({
    ...tab,
    ...(!tab?.userLabel && !hasAutomaticLabel(tab)
      ? { userLabel: tab.label }
      : {}),
    splitTree: tab.splitTree
      ? migrateSplitTreeToV11(tab.splitTree)
      : tab.splitTree,
  }));
}

/** Remove labels generated by the retired automatic-title experiment. */
export function removeAutomaticTabNamesFromSplitTree(node: any): any {
  if (!node || typeof node !== "object") return node;
  if (node.type === "group") {
    return {
      ...node,
      tabs: Array.isArray(node.tabs)
        ? node.tabs.map((tab: any) => {
            if (
              tab?.userLabel ||
              tab?.content?.kind !== "terminal" ||
              hasAutomaticLabel(tab)
            ) {
              return tab;
            }
            return {
              ...tab,
              label: tab.content.launch === "agent" ? "Agent" : "Terminal",
            };
          })
        : node.tabs,
    };
  }
  return {
    ...node,
    first: removeAutomaticTabNamesFromSplitTree(node.first),
    second: removeAutomaticTabNamesFromSplitTree(node.second),
  };
}

/** Restore fixed numbered fallbacks while preserving explicit manual names. */
export function removeAutomaticTabNamesFromUserTabs(userTabs: any[]): any[] {
  let nextAgent = 2;
  let nextTerminal = 1;
  return userTabs.map((tab) => {
    const splitTree = tab.splitTree
      ? removeAutomaticTabNamesFromSplitTree(tab.splitTree)
      : tab.splitTree;
    if (tab.kind !== "terminal") return { ...tab, splitTree };

    const isAgent = (tab.terminalLaunch ?? "shell") === "agent";
    const fallback = isAgent
      ? `Agent ${nextAgent++}`
      : `Terminal ${nextTerminal++}`;
    return {
      ...tab,
      splitTree,
      ...(!tab.userLabel && !hasAutomaticLabel(tab)
        ? { label: fallback }
        : {}),
    };
  });
}
