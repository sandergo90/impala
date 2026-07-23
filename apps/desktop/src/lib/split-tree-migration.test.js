import { describe, expect, test } from "bun:test";
import {
  migrateSplitTreeToV8,
  migrateSplitTreeToV10,
  migrateUserTabsToV7,
  migrateUserTabsToV8,
  migrateUserTabsToV10,
  migrateSplitTreeToV11,
  migrateUserTabsToV11,
  removeAutomaticTabNamesFromSplitTree,
  removeAutomaticTabNamesFromUserTabs,
} from "./split-tree-migration.ts";

describe("v6 to v7 user-tab migration", () => {
  test("preserves terminal pane ids while migrating legacy leaves", () => {
    const [tab] = migrateUserTabsToV7([
      {
        id: "terminal-1",
        kind: "terminal",
        splitTree: {
          type: "split",
          orientation: "vertical",
          ratio: 0.4,
          first: {
            type: "leaf",
            id: "tab-user-terminal-1",
            paneType: "shell",
            futureField: "keep-me",
          },
          second: { type: "leaf", id: "pane-2", paneType: "agent" },
        },
      },
    ]);

    expect(tab.focusedPaneId).toBe("tab-user-terminal-1");
    expect(tab.splitTree.first).toEqual({
      type: "leaf",
      id: "tab-user-terminal-1",
      content: { kind: "shell" },
      futureField: "keep-me",
    });
    expect(tab.splitTree.second.content).toEqual({ kind: "agent" });
  });

  test("restores browser URLs and file paths into primary leaves", () => {
    const [browser, file] = migrateUserTabsToV7([
      { id: "browser-1", kind: "browser", url: "https://example.com" },
      { id: "file-1", kind: "file", path: "src/App.tsx" },
    ]);

    expect(browser.splitTree).toEqual({
      type: "leaf",
      id: "tab-user-browser-1",
      content: { kind: "browser", url: "https://example.com" },
    });
    expect(file.splitTree).toEqual({
      type: "leaf",
      id: "tab-user-file-1",
      content: { kind: "file", path: "src/App.tsx" },
    });
  });
});

describe("v9 to v10 unified terminal migration", () => {
  test("converts agent and shell pane kinds into terminal launch profiles", () => {
    const tree = migrateSplitTreeToV10({
      type: "split",
      orientation: "vertical",
      ratio: 0.5,
      first: {
        type: "group",
        id: "agent-group",
        activeTabId: "agent-pane",
        tabs: [
          {
            id: "agent-pane",
            label: "Agent",
            content: { kind: "agent" },
            createdAt: 1,
          },
        ],
      },
      second: {
        type: "group",
        id: "shell-group",
        activeTabId: "shell-pane",
        tabs: [
          {
            id: "shell-pane",
            label: "Terminal",
            content: { kind: "shell" },
            createdAt: 2,
          },
        ],
      },
    });

    expect(tree.first.tabs[0].content).toEqual({
      kind: "terminal",
      launch: "agent",
    });
    expect(tree.second.tabs[0].content).toEqual({
      kind: "terminal",
      launch: "shell",
    });
  });

  test("keeps agent launch intent while collapsing the legacy user-tab kind", () => {
    const [tab] = migrateUserTabsToV10([
      {
        id: "agent-2",
        kind: "agent",
        label: "Agent 2",
        splitTree: {
          type: "group",
          id: "tab-user-agent-2",
          activeTabId: "tab-user-agent-2",
          tabs: [
            {
              id: "tab-user-agent-2",
              label: "Agent 2",
              content: { kind: "agent" },
              createdAt: 3,
            },
          ],
        },
      },
    ]);

    expect(tab.kind).toBe("terminal");
    expect(tab.terminalLaunch).toBe("agent");
    expect(tab.splitTree.tabs[0].content).toEqual({
      kind: "terminal",
      launch: "agent",
    });
  });
});

describe("v7 to v8 split-tree migration", () => {
  test("wraps leaves without changing pane identity or content", () => {
    const tree = migrateSplitTreeToV8({
      type: "split",
      orientation: "vertical",
      ratio: 0.5,
      first: {
        type: "leaf",
        id: "tab-agent",
        content: { kind: "agent" },
        futureField: "keep-me",
      },
      second: {
        type: "leaf",
        id: "pane-browser",
        content: { kind: "browser", url: "https://example.com" },
      },
    });

    expect(tree.first).toMatchObject({
      type: "group",
      id: "tab-agent",
      activeTabId: "tab-agent",
      tabs: [{ id: "tab-agent", content: { kind: "agent" } }],
      futureField: "keep-me",
    });
    expect(tree.second.tabs[0]).toMatchObject({
      id: "pane-browser",
      content: { kind: "browser", url: "https://example.com" },
    });
  });

  test("carries primary tab presentation metadata into its pane group", () => {
    const [tab] = migrateUserTabsToV8([
      {
        id: "file-1",
        kind: "file",
        label: "App.tsx",
        pinned: true,
        createdAt: 42,
        splitTree: {
          type: "leaf",
          id: "tab-user-file-1",
          content: { kind: "file", path: "src/App.tsx" },
        },
      },
    ]);

    expect(tab.splitTree.tabs[0]).toMatchObject({
      id: "tab-user-file-1",
      label: "App.tsx",
      pinned: true,
      createdAt: 42,
      content: { kind: "file", path: "src/App.tsx" },
    });
  });
});

describe("v10 to v11 manual title migration", () => {
  test("preserves renamed tabs as explicit overrides", () => {
    const [renamed, automatic] = migrateUserTabsToV11([
      {
        id: "one",
        kind: "terminal",
        terminalLaunch: "agent",
        label: "Investigate auth",
      },
      {
        id: "two",
        kind: "terminal",
        terminalLaunch: "agent",
        label: "Agent 2",
      },
    ]);

    expect(renamed.userLabel).toBe("Investigate auth");
    expect(automatic.userLabel).toBeUndefined();
  });

  test("preserves renamed pane tabs without locking automatic labels", () => {
    const tree = migrateSplitTreeToV11({
      type: "group",
      id: "pane",
      activeTabId: "agent",
      tabs: [
        {
          id: "agent",
          label: "Fix CI",
          content: { kind: "terminal", launch: "agent" },
        },
        {
          id: "shell",
          label: "Terminal",
          content: { kind: "terminal", launch: "shell" },
        },
      ],
    });

    expect(tree.tabs[0].userLabel).toBe("Fix CI");
    expect(tree.tabs[1].userLabel).toBeUndefined();
  });
});

describe("automatic title removal", () => {
  test("restores fixed labels while preserving explicit manual names", () => {
    const [automatic, manual] = removeAutomaticTabNamesFromUserTabs([
      {
        id: "generated",
        kind: "terminal",
        terminalLaunch: "agent",
        label: "Investigate stale terminal titles",
      },
      {
        id: "manual",
        kind: "terminal",
        terminalLaunch: "agent",
        label: "My agent",
        userLabel: "My agent",
      },
    ]);

    expect(automatic.label).toBe("Agent 2");
    expect(manual.label).toBe("My agent");
    expect(manual.userLabel).toBe("My agent");
  });

  test("removes generated pane labels but keeps manual pane labels", () => {
    const tree = removeAutomaticTabNamesFromSplitTree({
      type: "group",
      id: "pane",
      activeTabId: "generated",
      tabs: [
        {
          id: "generated",
          label: "$diagnose-local-dev-logs",
          content: { kind: "terminal", launch: "agent" },
        },
        {
          id: "manual",
          label: "Dev server",
          userLabel: "Dev server",
          content: { kind: "terminal", launch: "shell" },
        },
      ],
    });

    expect(tree.tabs[0].label).toBe("Agent");
    expect(tree.tabs[1].label).toBe("Dev server");
    expect(tree.tabs[1].userLabel).toBe("Dev server");
  });
});
