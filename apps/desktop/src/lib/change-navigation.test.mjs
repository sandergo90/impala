import { describe, expect, test } from "bun:test";
import {
  adjacentChangedFile,
  changedFileIndex,
  shouldOpenChangesNavigator,
} from "./change-navigation.ts";

const files = [
  { status: "M", path: "src/first.ts" },
  { status: "A", path: "src/second.ts" },
  { status: "D", path: "src/third.ts" },
];

describe("changed-file navigation", () => {
  test("reuses remembered uncommitted and all-changes views when entering Changes", () => {
    expect(shouldOpenChangesNavigator("terminal", "uncommitted")).toBe(false);
    expect(shouldOpenChangesNavigator("terminal", "all-changes")).toBe(false);
    expect(shouldOpenChangesNavigator("terminal", "commit")).toBe(true);
    expect(shouldOpenChangesNavigator("terminal", "last-turn")).toBe(true);
    expect(shouldOpenChangesNavigator("diff", "uncommitted")).toBe(true);
  });

  test("follows the visible file order and disables at both ends", () => {
    expect(changedFileIndex(files, "src/second.ts")).toBe(1);
    expect(adjacentChangedFile(files, "src/second.ts", -1)?.path).toBe("src/first.ts");
    expect(adjacentChangedFile(files, "src/second.ts", 1)?.path).toBe("src/third.ts");
    expect(adjacentChangedFile(files, "src/first.ts", -1)).toBeNull();
    expect(adjacentChangedFile(files, "src/third.ts", 1)).toBeNull();
  });

  test("does not navigate without a selected file or with no files", () => {
    expect(changedFileIndex(files, null)).toBe(-1);
    expect(adjacentChangedFile(files, null, 1)).toBeNull();
    expect(adjacentChangedFile([], "src/first.ts", -1)).toBeNull();
  });
});
