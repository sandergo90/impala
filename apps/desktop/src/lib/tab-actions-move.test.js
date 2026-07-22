import { beforeEach, describe, expect, test } from "bun:test";
import { findGroup, getLeaves } from "./split-tree.ts";

const persisted = new Map();
globalThis.localStorage = {
  getItem: (key) => persisted.get(key) ?? null,
  setItem: (key, value) => persisted.set(key, value),
  removeItem: (key) => persisted.delete(key),
  clear: () => persisted.clear(),
  key: (index) => [...persisted.keys()][index] ?? null,
  get length() {
    return persisted.size;
  },
};
globalThis.window = globalThis;

const { useUIStore } = await import("../store.ts");
const { moveWorkspaceTab } = await import("./tab-actions.ts");

const groupTab = (id, content, label = id) => ({
  id,
  label,
  content,
  createdAt: 1,
});

const group = (id, tab) => ({
  type: "group",
  id,
  tabs: [tab],
  activeTabId: tab.id,
});

const split = (first, second) => ({
  type: "split",
  orientation: "vertical",
  ratio: 0.5,
  first,
  second,
});

const userTab = (id, tree) => ({
  id,
  kind: "terminal",
  label: id,
  createdAt: 1,
  splitTree: tree,
  focusedPaneId: getLeaves(tree)[0].id,
});

const worktreePath = "/tmp/workspace-tab-moves";

function setTabs(tabs, activeTerminalsTab, extra = {}) {
  useUIStore.getState().updateWorktreeNavState(worktreePath, {
    userTabs: tabs,
    activeTerminalsTab,
    tabHistory: [],
    ...extra,
  });
}

beforeEach(() => {
  useUIStore.setState({ worktreeNavStates: {} });
});

describe("moveWorkspaceTab", () => {
  test("demotes a simple top-level tab without changing its content identity", () => {
    const primary = group("primary", groupTab("agent-session", { kind: "agent" }));
    const secondary = group(
      "secondary",
      groupTab("browser-session", { kind: "browser" }),
    );
    const owner = userTab("owner", split(primary, secondary));
    const movedSession = groupTab("shell-session", { kind: "shell" }, "Terminal");
    const simple = userTab("simple", group("simple-pane", movedSession));
    setTabs([owner, simple], owner.id, { tabHistory: [simple.id, "older"] });

    expect(
      moveWorkspaceTab(
        worktreePath,
        { type: "top-level", topTabId: simple.id },
        {
          type: "group",
          ownerTopTabId: owner.id,
          groupId: secondary.id,
          index: 1,
        },
      ),
    ).toBe(true);

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    expect(nav.userTabs.map((tab) => tab.id)).toEqual([owner.id]);
    expect(findGroup(nav.userTabs[0].splitTree, secondary.id).tabs[1]).toBe(
      movedSession,
    );
    expect(nav.activeTerminalsTab).toBe(owner.id);
    expect(nav.userTabs[0].focusedPaneId).toBe(secondary.id);
    expect(nav.tabHistory).toEqual(["older"]);
  });

  test("promotes a secondary browser tab and collapses its empty group", () => {
    const primary = group("primary", groupTab("shell-session", { kind: "shell" }));
    const browser = groupTab(
      "browser-session",
      { kind: "browser", url: "https://example.com" },
      "Browser",
    );
    const secondary = group("secondary", browser);
    const owner = userTab("owner", split(primary, secondary));
    setTabs([owner], owner.id);

    expect(
      moveWorkspaceTab(
        worktreePath,
        {
          type: "group-tab",
          ownerTopTabId: owner.id,
          groupId: secondary.id,
          groupTabId: browser.id,
        },
        { type: "top-level", index: 1 },
      ),
    ).toBe(true);

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const promoted = nav.userTabs[1];
    expect(getLeaves(nav.userTabs[0].splitTree).map((pane) => pane.id)).toEqual([
      primary.id,
    ]);
    expect(getLeaves(promoted.splitTree)[0].tabs[0]).toBe(browser);
    expect(promoted.kind).toBe("browser");
    expect(promoted.label).toBe("Browser");
    expect(promoted.url).toBe("https://example.com");
    expect(nav.activeTerminalsTab).toBe(promoted.id);
    expect(nav.tabHistory).toEqual([owner.id]);
  });

  test("moves between secondary groups and collapses an emptied source", () => {
    const primary = group("primary", groupTab("agent-session", { kind: "agent" }));
    const movedSession = groupTab("shell-session", { kind: "shell" });
    const source = group("source", movedSession);
    const target = group("target", groupTab("browser-session", { kind: "browser" }));
    const owner = userTab("owner", split(primary, split(source, target)));
    setTabs([owner], owner.id);

    expect(
      moveWorkspaceTab(
        worktreePath,
        {
          type: "group-tab",
          ownerTopTabId: owner.id,
          groupId: source.id,
          groupTabId: movedSession.id,
        },
        {
          type: "group",
          ownerTopTabId: owner.id,
          groupId: target.id,
          index: 1,
        },
      ),
    ).toBe(true);

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const tree = nav.userTabs[0].splitTree;
    expect(getLeaves(tree).map((pane) => pane.id)).toEqual([primary.id, target.id]);
    expect(findGroup(tree, target.id).tabs[1]).toBe(movedSession);
    expect(nav.userTabs[0].focusedPaneId).toBe(target.id);
  });

  test("rejects complex top-level tabs and invalid system sources as no-ops", () => {
    const targetPrimary = group(
      "target-primary",
      groupTab("target-primary-tab", { kind: "agent" }),
    );
    const targetSecondary = group(
      "target-secondary",
      groupTab("target-secondary-tab", { kind: "shell" }),
    );
    const targetOwner = userTab("target-owner", split(targetPrimary, targetSecondary));
    const complex = userTab(
      "complex",
      split(
        group("complex-a", groupTab("complex-a-tab", { kind: "shell" })),
        group("complex-b", groupTab("complex-b-tab", { kind: "browser" })),
      ),
    );
    setTabs([targetOwner, complex], targetOwner.id);
    const before = useUIStore.getState().getWorktreeNavState(worktreePath);

    expect(
      moveWorkspaceTab(
        worktreePath,
        { type: "top-level", topTabId: complex.id },
        {
          type: "group",
          ownerTopTabId: targetOwner.id,
          groupId: targetSecondary.id,
        },
      ),
    ).toBe(false);
    expect(
      moveWorkspaceTab(
        worktreePath,
        {
          type: "group-tab",
          ownerTopTabId: "tab-agent",
          groupId: "tab-agent",
          groupTabId: "tab-agent",
        },
        { type: "top-level" },
      ),
    ).toBe(false);
    expect(useUIStore.getState().getWorktreeNavState(worktreePath)).toEqual(before);
  });
});
