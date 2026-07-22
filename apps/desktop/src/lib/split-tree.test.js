import { describe, expect, test } from "bun:test";
import {
  addTabToGroup,
  createGroupTab,
  findGroup,
  findGroupTab,
  getActiveGroupTab,
  getAdjacentGroupTabId,
  getAdjacentLeafId,
  getLeaves,
  getHorizontalNeighborGroupId,
  normalizeLegacySplitTree,
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

describe("normalizeSplitTree", () => {
  test("upgrades legacy leaves to identity-preserving groups", () => {
    const tree = normalizeLegacySplitTree({
      type: "split",
      orientation: "vertical",
      ratio: 0.5,
      first: { type: "leaf", id: "agent-pane", paneType: "agent" },
      second: { type: "leaf", id: "shell-pane", paneType: "shell" },
    });

    expect(getLeaves(tree).map((pane) => getActiveGroupTab(pane).content.kind)).toEqual([
      "agent",
      "shell",
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
});
