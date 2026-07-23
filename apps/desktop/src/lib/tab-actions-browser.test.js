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
const { openBrowserTabAt } = await import("./tab-actions.ts");

const worktreePath = "/tmp/browser-service-focus";
const groupTab = (id, content) => ({
  id,
  label: id,
  content,
  createdAt: 1,
});
const group = (id, tabs, activeTabId = tabs[0].id) => ({
  type: "group",
  id,
  tabs,
  activeTabId,
});
const split = (first, second) => ({
  type: "split",
  orientation: "vertical",
  ratio: 0.5,
  first,
  second,
});

beforeEach(() => {
  useUIStore.setState({ worktreeNavStates: {} });
});

describe("openBrowserTabAt", () => {
  test("focuses a hidden browser tab in any user split pane on the service origin", () => {
    const browser = groupTab("browser-pane", {
      kind: "browser",
      url: "http://127.0.0.1:5173/dashboard",
    });
    const secondary = group(
      "secondary",
      [
        groupTab("shell-pane", { kind: "terminal", launch: "shell" }),
        browser,
      ],
      "shell-pane",
    );
    const owner = {
      id: "owner",
      kind: "terminal",
      label: "Terminal",
      createdAt: 1,
      splitTree: split(
        group("primary", [
          groupTab("primary-shell", { kind: "terminal", launch: "shell" }),
        ]),
        secondary,
      ),
      focusedPaneId: "primary",
    };
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      userTabs: [owner],
      activeTerminalsTab: "tab-agent",
    });

    openBrowserTabAt(worktreePath, "http://localhost:5173", {
      matchOrigin: true,
    });

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    expect(nav.userTabs).toHaveLength(1);
    expect(nav.activeTerminalsTab).toBe(owner.id);
    expect(nav.userTabs[0].focusedPaneId).toBe("secondary");
    expect(findGroup(nav.userTabs[0].splitTree, "secondary").activeTabId).toBe(
      browser.id,
    );
  });

  test("focuses a matching browser inside the Agent split tree", () => {
    const browser = groupTab("agent-browser", {
      kind: "browser",
      url: "http://localhost:3000/",
    });
    const tree = split(
      group("tab-agent", [
        groupTab("tab-agent", { kind: "terminal", launch: "agent" }),
      ]),
      group("agent-secondary", [browser]),
    );
    useUIStore.getState().updateWorktreeNavState(worktreePath, {
      activeTerminalsTab: "tab-agent",
      agentTabSplitTree: tree,
      agentTabFocusedPaneId: "tab-agent",
    });

    openBrowserTabAt(worktreePath, "http://localhost:3000", {
      matchOrigin: true,
    });

    const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
    expect(nav.activeTerminalsTab).toBe("tab-agent");
    expect(nav.agentTabFocusedPaneId).toBe("agent-secondary");
    expect(findGroup(nav.agentTabSplitTree, "agent-secondary").activeTabId).toBe(
      browser.id,
    );
  });
});
