import { describe, expect, test } from "bun:test";
import {
  migrateSplitTreeToV8,
  migrateUserTabsToV7,
  migrateUserTabsToV8,
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
