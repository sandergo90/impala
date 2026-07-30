import { beforeEach, describe, expect, test } from "bun:test";
import { findGroup } from "./split-tree.ts";

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
const {
  getActiveFilePath,
  openFileTabFromPane,
  openFileTabFromTree,
} = await import("./tab-actions.ts");
const { openFileFromFinder } = await import("./file-finder-actions.ts");

const worktreePath = "/tmp/file-link-pane-routing";
const groupTab = (id, content, extra = {}) => ({
  id,
  label: id,
  content,
  createdAt: 1,
  ...extra,
});
const group = (id, tabs, activeTabId = tabs[0].id) => ({
  type: "group",
  id,
  tabs,
  activeTabId,
});
const split = (first, second, orientation = "vertical") => ({
  type: "split",
  orientation,
  ratio: 0.5,
  first,
  second,
});

beforeEach(() => {
  persisted.clear();
  useUIStore.setState({ worktreeNavStates: {} });
});

describe("openFileTabFromPane", () => {
  test("opens a new file tab in the pane to the right of the source agent", () => {
    const tree = split(
      group("tab-agent", [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
      ]),
      group("right-pane", [
        groupTab("right-shell", { kind: "terminal", launch: "shell" }),
      ]),
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      agentTabFocusedPaneId: "tab-agent",
      activeTerminalsTab: "tab-agent",
    });

    openFileTabFromPane(
      worktreePath,
      "apps/desktop/src/store.ts",
      { topTabId: "tab-agent", groupId: "tab-agent" },
      { line: 128, col: 3 },
    );

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const right = findGroup(nav.agentTabSplitTree, "right-pane");
    expect(nav.activeTerminalsTab).toBe("tab-agent");
    expect(nav.agentTabFocusedPaneId).toBe("right-pane");
    expect(right.tabs).toHaveLength(2);
    expect(right.tabs[1].content).toEqual({
      kind: "file",
      path: "apps/desktop/src/store.ts",
    });
    expect(right.activeTabId).toBe(right.tabs[1].id);
  });

  test("retargets the neighboring pane's unpinned file preview", () => {
    const preview = groupTab(
      "file-preview",
      { kind: "file", path: "old.ts" },
      { label: "old.ts" },
    );
    const tree = split(
      group("tab-agent", [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
      ]),
      group(
        "right-pane",
        [
          groupTab("right-shell", { kind: "terminal", launch: "shell" }),
          preview,
        ],
        "right-shell",
      ),
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      activeTerminalsTab: "tab-agent",
    });

    openFileTabFromPane(worktreePath, "new/location.ts", {
      topTabId: "tab-agent",
      groupId: "tab-agent",
    });

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const right = findGroup(nav.agentTabSplitTree, "right-pane");
    expect(right.tabs).toHaveLength(2);
    expect(right.tabs[1].id).toBe("file-preview");
    expect(right.tabs[1].label).toBe("location.ts");
    expect(right.tabs[1].content).toEqual({
      kind: "file",
      path: "new/location.ts",
    });
    expect(right.activeTabId).toBe("file-preview");
  });

  test("focuses an existing file in the split layout instead of duplicating it", () => {
    const existing = groupTab("existing-file", {
      kind: "file",
      path: "README.md",
    });
    const tree = split(
      group("tab-agent", [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
      ]),
      group(
        "right-pane",
        [
          groupTab("right-shell", { kind: "terminal", launch: "shell" }),
          existing,
        ],
        "right-shell",
      ),
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      activeTerminalsTab: "tab-agent",
    });

    openFileTabFromPane(worktreePath, "README.md", {
      topTabId: "tab-agent",
      groupId: "tab-agent",
    });

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const right = findGroup(nav.agentTabSplitTree, "right-pane");
    expect(right.tabs).toHaveLength(2);
    expect(right.activeTabId).toBe("existing-file");
    expect(nav.agentTabFocusedPaneId).toBe("right-pane");
  });

  test("does not hide the source agent to reuse a file tab in its group", () => {
    const hiddenSourceFile = groupTab("source-file", {
      kind: "file",
      path: "README.md",
    });
    const tree = split(
      group(
        "tab-agent",
        [
          groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
          hiddenSourceFile,
        ],
        "tab-agent",
      ),
      group("right-pane", [
        groupTab("right-shell", { kind: "terminal", launch: "shell" }),
      ]),
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      activeTerminalsTab: "tab-agent",
    });

    openFileTabFromPane(worktreePath, "README.md", {
      topTabId: "tab-agent",
      groupId: "tab-agent",
    });

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const source = findGroup(nav.agentTabSplitTree, "tab-agent");
    const right = findGroup(nav.agentTabSplitTree, "right-pane");
    expect(source.activeTabId).toBe("tab-agent");
    expect(right.tabs).toHaveLength(2);
    expect(right.tabs[1].content).toEqual({
      kind: "file",
      path: "README.md",
    });
    expect(nav.agentTabFocusedPaneId).toBe("right-pane");
  });

  test("opens a right file split when the source agent is the only pane", () => {
    const tree = group("tab-agent", [
      groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
    ]);
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      activeTerminalsTab: "tab-agent",
    });

    openFileTabFromPane(worktreePath, "README.md", {
      topTabId: "tab-agent",
      groupId: "tab-agent",
    });

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    expect(nav.userTabs).toHaveLength(0);
    expect(nav.agentTabSplitTree.type).toBe("split");
    expect(nav.agentTabSplitTree.orientation).toBe("vertical");
    expect(nav.agentTabSplitTree.first.id).toBe("tab-agent");
    const right = findGroup(
      nav.agentTabSplitTree,
      nav.agentTabFocusedPaneId,
    );
    expect(right.tabs).toHaveLength(1);
    expect(right.tabs[0].content).toEqual({
      kind: "file",
      path: "README.md",
    });
    expect(nav.activeTerminalsTab).toBe("tab-agent");
  });

  test("keeps the existing fallback when the unsplit pane has multiple tabs", () => {
    const tree = group(
      "tab-agent",
      [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
        groupTab("other-agent", { kind: "terminal", launch: "agent" }),
      ],
      "tab-agent",
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      agentTabFocusedPaneId: "tab-agent",
      activeTerminalsTab: "tab-agent",
    });

    openFileTabFromPane(worktreePath, "README.md", {
      topTabId: "tab-agent",
      groupId: "tab-agent",
    });

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    expect(nav.agentTabSplitTree).toEqual(tree);
    expect(nav.userTabs).toHaveLength(1);
    expect(nav.userTabs[0].path).toBe("README.md");
  });
});

describe("getActiveFilePath", () => {
  test("resolves the active file in the focused agent split pane", () => {
    const tree = split(
      group("tab-agent", [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
      ]),
      group(
        "right-pane",
        [
          groupTab("file-a", { kind: "file", path: "src/a.ts" }),
          groupTab("file-b", { kind: "file", path: "src/b.ts" }),
        ],
        "file-b",
      ),
    );
    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);

    expect(
      getActiveFilePath({
        ...nav,
        activeTerminalsTab: "tab-agent",
        agentTabSplitTree: tree,
        agentTabFocusedPaneId: "right-pane",
      }),
    ).toBe("src/b.ts");
  });

  test("resolves the active file in the focused user split pane", () => {
    const topTab = {
      id: "terminal-1",
      kind: "terminal",
      terminalLaunch: "shell",
      label: "Terminal 1",
      createdAt: 1,
      splitTree: split(
        group("primary", [
          groupTab("shell", { kind: "terminal", launch: "shell" }),
        ]),
        group("right-pane", [
          groupTab("file", { kind: "file", path: "src/file.ts" }),
        ]),
      ),
      focusedPaneId: "right-pane",
    };
    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);

    expect(
      getActiveFilePath({
        ...nav,
        activeTerminalsTab: topTab.id,
        userTabs: [topTab],
      }),
    ).toBe("src/file.ts");
  });
});

describe("openFileTabFromTree", () => {
  test("opens the selected file in the focused split pane", () => {
    const tree = split(
      group("tab-agent", [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
      ]),
      group("right-pane", [
        groupTab("right-shell", { kind: "terminal", launch: "shell" }),
      ]),
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      agentTabFocusedPaneId: "right-pane",
      activeTerminalsTab: "tab-agent",
    });

    openFileTabFromTree(worktreePath, "apps/desktop/src/store.ts");

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const right = findGroup(nav.agentTabSplitTree, "right-pane");
    expect(nav.userTabs).toHaveLength(0);
    expect(nav.activeTerminalsTab).toBe("tab-agent");
    expect(right.tabs).toHaveLength(2);
    expect(right.tabs[1].content).toEqual({
      kind: "file",
      path: "apps/desktop/src/store.ts",
    });
    expect(right.activeTabId).toBe(right.tabs[1].id);
  });

  test("uses the auxiliary split when the primary pane still has focus", () => {
    const tree = split(
      group("tab-agent", [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
      ]),
      group("right-pane", [
        groupTab("right-shell", { kind: "terminal", launch: "shell" }),
      ]),
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      agentTabFocusedPaneId: "tab-agent",
      activeTerminalsTab: "tab-agent",
    });

    openFileTabFromTree(worktreePath, "README.md");

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const primary = findGroup(nav.agentTabSplitTree, "tab-agent");
    const right = findGroup(nav.agentTabSplitTree, "right-pane");
    expect(primary.activeTabId).toBe("tab-agent");
    expect(right.tabs[1].content).toEqual({
      kind: "file",
      path: "README.md",
    });
    expect(nav.agentTabFocusedPaneId).toBe("right-pane");
  });

  test("retargets and pins the auxiliary pane's file preview", () => {
    const preview = groupTab(
      "file-preview",
      { kind: "file", path: "old.ts" },
      { label: "old.ts" },
    );
    const tree = split(
      group("tab-agent", [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
      ]),
      group("right-pane", [preview]),
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      agentTabFocusedPaneId: "right-pane",
      activeTerminalsTab: "tab-agent",
    });

    openFileTabFromTree(worktreePath, "new/location.ts", { pin: true });

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const right = findGroup(nav.agentTabSplitTree, "right-pane");
    expect(right.tabs).toHaveLength(1);
    expect(right.tabs[0]).toMatchObject({
      id: "file-preview",
      label: "location.ts",
      pinned: true,
      content: { kind: "file", path: "new/location.ts" },
    });
  });

  test("opens in a user tab's auxiliary split pane", () => {
    const tree = split(
      group("primary-pane", [
        groupTab("primary-pane", { kind: "terminal", launch: "shell" }),
      ]),
      group("secondary-pane", [
        groupTab("secondary-browser", { kind: "browser" }),
      ]),
    );
    const owner = {
      id: "terminal-1",
      kind: "terminal",
      terminalLaunch: "shell",
      label: "Terminal 1",
      createdAt: 1,
      splitTree: tree,
      focusedPaneId: "secondary-pane",
    };
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      userTabs: [owner],
      activeTerminalsTab: owner.id,
    });

    openFileTabFromTree(worktreePath, "README.md");

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const updatedOwner = nav.userTabs[0];
    const secondary = findGroup(updatedOwner.splitTree, "secondary-pane");
    expect(nav.userTabs).toHaveLength(1);
    expect(nav.activeTerminalsTab).toBe(owner.id);
    expect(updatedOwner.focusedPaneId).toBe("secondary-pane");
    expect(secondary.tabs[1].content).toEqual({
      kind: "file",
      path: "README.md",
    });
  });

  test("keeps top-level preview behavior when there is no split pane", () => {
    openFileTabFromTree(worktreePath, "README.md");

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    expect(nav.userTabs).toHaveLength(1);
    expect(nav.userTabs[0].path).toBe("README.md");
  });
});

describe("openFileFromFinder", () => {
  test("opens the selected file in the existing split instead of a top-level tab", () => {
    const tree = split(
      group("tab-agent", [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
      ]),
      group("right-pane", [
        groupTab("right-shell", { kind: "terminal", launch: "shell" }),
      ]),
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      agentTabSplitTree: tree,
      agentTabFocusedPaneId: "right-pane",
      activeTerminalsTab: "tab-agent",
    });

    openFileFromFinder(worktreePath, "apps/desktop/src/store.ts", false);

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    const right = findGroup(nav.agentTabSplitTree, "right-pane");
    expect(nav.userTabs).toHaveLength(0);
    expect(nav.activeTerminalsTab).toBe("tab-agent");
    expect(right.tabs).toHaveLength(2);
    expect(right.tabs[1].content).toEqual({
      kind: "file",
      path: "apps/desktop/src/store.ts",
    });
    expect(right.activeTabId).toBe(right.tabs[1].id);
  });
});
