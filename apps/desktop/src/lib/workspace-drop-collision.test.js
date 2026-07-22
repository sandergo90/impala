import { describe, expect, test } from "bun:test";
import { selectWorkspaceDropCollision } from "./workspace-drop-collision";

describe("selectWorkspaceDropCollision", () => {
  test("prefers the pane group when its header overlaps the workspace strip", () => {
    const strip = { id: "top-level-strip" };
    const leftPane = { id: "group:primary" };

    expect(
      selectWorkspaceDropCollision([
        {
          collision: strip,
          target: { type: "top-level", index: 0 },
        },
        {
          collision: leftPane,
          target: {
            type: "group",
            ownerTopTabId: "tab-agent",
            groupId: "tab-agent",
            index: 1,
          },
        },
      ]),
    ).toBe(leftPane);
  });

  test("keeps the workspace strip when no pane-local target is hit", () => {
    const strip = { id: "top-level-strip" };

    expect(
      selectWorkspaceDropCollision([
        {
          collision: strip,
          target: { type: "top-level", index: 0 },
        },
      ]),
    ).toBe(strip);
  });
});
