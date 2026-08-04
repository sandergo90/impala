import { describe, expect, test } from "bun:test";
import { shouldOpenChangesNavigator } from "./change-navigation.ts";

describe("changed-file navigation", () => {
  test("reuses remembered uncommitted and all-changes views when entering Changes", () => {
    expect(shouldOpenChangesNavigator("terminal", "uncommitted")).toBe(false);
    expect(shouldOpenChangesNavigator("terminal", "all-changes")).toBe(false);
    expect(shouldOpenChangesNavigator("terminal", "commit")).toBe(true);
    expect(shouldOpenChangesNavigator("terminal", "last-turn")).toBe(true);
    expect(shouldOpenChangesNavigator("diff", "uncommitted")).toBe(true);
  });
});
