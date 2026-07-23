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
const { openFileTabFromPane } = await import("./tab-actions.ts");

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

  test("falls back to a top-level file tab without a horizontal neighbor", () => {
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
    expect(nav.userTabs).toHaveLength(1);
    expect(nav.userTabs[0].kind).toBe("file");
    expect(nav.userTabs[0].path).toBe("README.md");
    expect(nav.activeTerminalsTab).toBe(nav.userTabs[0].id);
  });
});
