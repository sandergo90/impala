import { describe, expect, test } from "bun:test";
import {
  addTabToGroup,
  createGroupTab,
  extractGroupTab,
  findGroup,
  findGroupTab,
  getActiveGroupTab,
  getAdjacentGroupTabId,
  getAdjacentLeafId,
  getLeaves,
  getHorizontalNeighborGroupId,
  normalizeLegacySplitTree,
  insertGroupTab,
  insertGroupAtEdge,
  moveGroupTab,
  openUrlInBrowserSplit,
  removeGroupTab,
  removeNode,
  setActiveGroupTab,
  splitNode,
  updateLeafContent,
  updateRatio,
  shouldUseGroupTabs,
} from "./split-tree.ts";

const group = (id, content) => ({
  type: "group",
  id,
  tabs: [{ id, label: id, content, createdAt: 0 }],
  activeTabId: id,
});

describe("openUrlInBrowserSplit", () => {
  test("creates a browser immediately to the right of the source group", () => {
    const root = group("terminal-pane", {
      kind: "terminal",
      launch: "agent",
    });
    const result = openUrlInBrowserSplit(
      root,
      root.id,
      "https://example.com/docs",
    );

    expect(result.created).toBe(true);
    expect(result.tree.orientation).toBe("vertical");
    expect(getLeaves(result.tree).map((pane) => pane.id)).toEqual([
      root.id,
      result.browserGroupId,
    ]);
    expect(findGroupTab(result.tree, result.browserTabId).tab.content).toEqual({
      kind: "browser",
      url: "https://example.com/docs",
    });
  });

  test("reuses a visible browser pane without adding another split", () => {
    const root = group("terminal-pane", {
      kind: "terminal",
      launch: "shell",
    });
    const split = splitNode(root, root.id, "vertical", {
      kind: "browser",
      url: "https://old.example",
    });
    const result = openUrlInBrowserSplit(
      split.tree,
      root.id,
      "https://new.example",
    );

    expect(result.created).toBe(false);
    expect(getLeaves(result.tree)).toHaveLength(2);
    expect(findGroupTab(result.tree, result.browserTabId).tab.content).toEqual({
      kind: "browser",
      url: "https://new.example",
    });
  });

  test("opens a browser tab in an existing split pane", () => {
    const root = group("terminal-pane", {
      kind: "terminal",
      launch: "agent",
    });
    const split = splitNode(root, root.id, "vertical", {
      kind: "terminal",
      launch: "shell",
    });
    const targetGroup = findGroup(split.tree, split.newLeafId);
    const result = openUrlInBrowserSplit(
      split.tree,
      root.id,
      "https://example.com/docs",
    );

    expect(result.created).toBe(true);
    expect(result.browserGroupId).toBe(targetGroup.id);
    expect(getLeaves(result.tree)).toHaveLength(2);
    expect(findGroup(result.tree, targetGroup.id).tabs).toHaveLength(2);
    expect(getActiveGroupTab(findGroup(result.tree, targetGroup.id)).content).toEqual(
      {
        kind: "browser",
        url: "https://example.com/docs",
      },
    );
  });

  test("activates a hidden browser tab in an existing split pane", () => {
    const root = group("terminal-pane", {
      kind: "terminal",
      launch: "agent",
    });
    const split = splitNode(root, root.id, "vertical", {
      kind: "terminal",
      launch: "shell",
    });
    const targetGroup = findGroup(split.tree, split.newLeafId);
    const browser = createGroupTab("existing-browser", {
      kind: "browser",
      url: "https://old.example",
    });
    const withBrowser = setActiveGroupTab(
      addTabToGroup(split.tree, targetGroup.id, browser),
      targetGroup.id,
      targetGroup.activeTabId,
    );
    const result = openUrlInBrowserSplit(
      withBrowser,
      root.id,
      "https://new.example",
    );

    expect(result.created).toBe(false);
    expect(getLeaves(result.tree)).toHaveLength(2);
    expect(findGroup(result.tree, targetGroup.id).tabs).toHaveLength(2);
    expect(getActiveGroupTab(findGroup(result.tree, targetGroup.id)).id).toBe(
      browser.id,
    );
    expect(findGroupTab(result.tree, browser.id).tab.content.url).toBe(
      "https://new.example",
    );
  });

  test("does not replace the source terminal with a hidden browser tab", () => {
    const root = group("terminal-pane", {
      kind: "terminal",
      launch: "shell",
    });
    const browser = createGroupTab("hidden-browser", {
      kind: "browser",
      url: "https://old.example",
    });
    const stacked = setActiveGroupTab(
      addTabToGroup(root, root.id, browser),
      root.id,
      root.tabs[0].id,
    );
    const result = openUrlInBrowserSplit(
      stacked,
      root.id,
      "https://new.example",
    );

    expect(result.created).toBe(true);
    expect(getLeaves(result.tree)).toHaveLength(2);
    expect(getActiveGroupTab(findGroup(result.tree, root.id)).content.kind).toBe(
      "terminal",
    );
  });

  test("does not reuse a browser tab in the source group as a split pane", () => {
    const source = group("left-pane", {
      kind: "browser",
      url: "https://old.example",
    });
    const result = openUrlInBrowserSplit(
      source,
      source.id,
      "https://new.example",
    );

    expect(result.created).toBe(true);
    expect(getLeaves(result.tree)).toHaveLength(2);
    expect(getActiveGroupTab(findGroup(result.tree, source.id)).content.url).toBe(
      "https://old.example",
    );
    expect(findGroupTab(result.tree, result.browserTabId).tab.content.url).toBe(
      "https://new.example",
    );
  });
});

describe("normalizeSplitTree", () => {
  test("upgrades legacy leaves to identity-preserving groups", () => {
    const tree = normalizeLegacySplitTree({
      type: "split",
      orientation: "vertical",
      ratio: 0.5,
      first: { type: "leaf", id: "agent-pane", paneType: "agent" },
      second: { type: "leaf", id: "shell-pane", paneType: "shell" },
    });

    expect(
      getLeaves(tree).map((pane) => getActiveGroupTab(pane).content),
    ).toEqual([
      { kind: "terminal", launch: "agent" },
      { kind: "terminal", launch: "shell" },
    ]);
    expect(getLeaves(tree).map((pane) => pane.activeTabId)).toEqual([
      "agent-pane",
      "shell-pane",
    ]);
  });
});

describe("group-bearing split trees", () => {
  test("splits with requested content and preserves the existing group", () => {
    const root = group("tab-user-1", { kind: "file", path: "README.md" });
    const result = splitNode(root, root.id, "vertical", {
      kind: "browser",
      url: "http://localhost:3000",
    });

    expect(result).not.toBeNull();
    expect(getLeaves(result.tree).map((pane) => getActiveGroupTab(pane).content)).toEqual([
      { kind: "file", path: "README.md" },
      { kind: "browser", url: "http://localhost:3000" },
    ]);
    expect(getAdjacentLeafId(result.tree, root.id, 1)).toBe(result.newLeafId);
  });

  test("finds horizontal neighbors through nested split geometry", () => {
    const left = group("left", { kind: "agent" });
    const right = splitNode(left, "left", "vertical", { kind: "shell" });
    const nested = splitNode(
      right.tree,
      right.newLeafId,
      "horizontal",
      { kind: "browser" },
    );
    const [leftPane, rightTop, rightBottom] = getLeaves(nested.tree);

    expect(getHorizontalNeighborGroupId(nested.tree, leftPane.id, "right")).toBe(
      rightTop.id,
    );
    expect(getHorizontalNeighborGroupId(nested.tree, rightTop.id, "left")).toBe(
      leftPane.id,
    );
    expect(getHorizontalNeighborGroupId(nested.tree, rightBottom.id, "left")).toBe(
      leftPane.id,
    );
    expect(getHorizontalNeighborGroupId(nested.tree, rightTop.id, "right")).toBeNull();
  });

  test("updates the intended ratio in a nested tree", () => {
    const root = group("root", { kind: "agent" });
    const first = splitNode(root, root.id, "vertical", { kind: "shell" });
    const second = splitNode(first.tree, root.id, "horizontal", { kind: "browser" });
    const resized = updateRatio(second.tree, first.newLeafId, 0.7);

    expect(resized.ratio).toBe(0.7);
    expect(resized.first.ratio).toBe(0.5);
  });

  test("updates tab content and collapses a removed group", () => {
    const root = group("root", { kind: "agent" });
    const split = splitNode(root, root.id, "vertical", { kind: "browser" });
    const withUrl = updateLeafContent(
      split.tree,
      split.newLeafId,
      () => ({ kind: "browser", url: "https://example.com" }),
    );

    expect(findGroupTab(withUrl, split.newLeafId).tab.content.url).toBe(
      "https://example.com",
    );
    expect(removeNode(withUrl, split.newLeafId)).toEqual(root);
  });
});

describe("tabs inside groups", () => {
  test("adds, activates, and closes tabs without changing their ids", () => {
    const root = group("pane", { kind: "agent" });
    const browser = createGroupTab("browser-session", { kind: "browser" }, "Browser");
    const withBrowser = addTabToGroup(root, root.id, browser);

    expect(findGroup(withBrowser, root.id).tabs.map((tab) => tab.id)).toEqual([
      "pane",
      "browser-session",
    ]);
    expect(getActiveGroupTab(findGroup(withBrowser, root.id)).id).toBe("browser-session");

    const switched = setActiveGroupTab(withBrowser, root.id, "pane");
    expect(getActiveGroupTab(findGroup(switched, root.id)).id).toBe("pane");
    expect(getAdjacentGroupTabId(findGroup(switched, root.id), 1)).toBe(
      "browser-session",
    );
    expect(shouldUseGroupTabs(switched, root.id)).toBe(true);

    const closed = removeGroupTab(switched, root.id, "pane");
    expect(closed.removed.id).toBe("pane");
    expect(getActiveGroupTab(findGroup(closed.tree, root.id)).id).toBe("browser-session");
  });

  test("removing the last tab removes its group", () => {
    const root = group("only-pane", { kind: "shell" });
    expect(shouldUseGroupTabs(root, root.id)).toBe(false);
    expect(removeGroupTab(root, root.id, root.id).tree).toBeNull();
  });

  test("inserts and reorders existing tabs without changing identity", () => {
    const root = group("pane", { kind: "agent" });
    const browser = createGroupTab("browser-session", { kind: "browser" }, "Browser");
    const shell = createGroupTab("shell-session", { kind: "shell" }, "Terminal");
    const stacked = insertGroupTab(
      insertGroupTab(root, root.id, browser),
      root.id,
      shell,
    );
    const moved = moveGroupTab(stacked, root.id, browser.id, root.id, 2);

    expect(findGroup(moved, root.id).tabs).toEqual([
      root.tabs[0],
      shell,
      browser,
    ]);
    expect(getActiveGroupTab(findGroup(moved, root.id))).toBe(browser);
  });

  test("moves a tab between groups and collapses an emptied source", () => {
    const root = group("primary", { kind: "agent" });
    const split = splitNode(root, root.id, "vertical", { kind: "browser" });
    const browser = getActiveGroupTab(findGroup(split.tree, split.newLeafId));
    const moved = moveGroupTab(
      split.tree,
      split.newLeafId,
      browser.id,
      root.id,
      1,
    );

    expect(getLeaves(moved).map((pane) => pane.id)).toEqual([root.id]);
    expect(findGroup(moved, root.id).tabs).toEqual([root.tabs[0], browser]);
    expect(getActiveGroupTab(findGroup(moved, root.id))).toBe(browser);
  });

  test("extracts a tab without disposing or cloning it", () => {
    const root = group("pane", { kind: "agent" });
    const file = createGroupTab(
      "editor-buffer",
      { kind: "file", path: "notes.md" },
      "notes.md",
    );
    const stacked = addTabToGroup(root, root.id, file);
    const result = extractGroupTab(stacked, root.id, file.id);

    expect(result.tab).toBe(file);
    expect(findGroup(result.tree, root.id).tabs).toEqual(root.tabs);
  });

  test("inserts an existing tab on each pane edge with spatially correct ordering", () => {
    const target = group("target", { kind: "agent" });
    const moved = createGroupTab("browser-session", { kind: "browser" }, "Browser");

    const left = insertGroupAtEdge(target, target.id, "left", moved);
    expect(left.orientation).toBe("vertical");
    expect(getLeaves(left).map((pane) => pane.tabs[0])).toEqual([
      moved,
      target.tabs[0],
    ]);

    const right = insertGroupAtEdge(target, target.id, "right", moved);
    expect(right.orientation).toBe("vertical");
    expect(getLeaves(right).map((pane) => pane.tabs[0])).toEqual([
      target.tabs[0],
      moved,
    ]);

    const top = insertGroupAtEdge(target, target.id, "top", moved);
    expect(top.orientation).toBe("horizontal");
    expect(getLeaves(top).map((pane) => pane.tabs[0])).toEqual([
      moved,
      target.tabs[0],
    ]);

    const bottom = insertGroupAtEdge(target, target.id, "bottom", moved);
    expect(bottom.orientation).toBe("horizontal");
    expect(getLeaves(bottom).map((pane) => pane.tabs[0])).toEqual([
      target.tabs[0],
      moved,
    ]);
  });
});
