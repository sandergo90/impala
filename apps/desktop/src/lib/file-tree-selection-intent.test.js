import { describe, expect, test } from "bun:test";
import { FileTree } from "@pierre/trees";
import { FileTreeSelectionIntent } from "./file-tree-selection-intent.ts";

describe("FileTreeSelectionIntent", () => {
  test("a programmatic reveal does not open a top-level file tab", () => {
    const intent = new FileTreeSelectionIntent();
    const opened = [];
    const tree = new FileTree({
      paths: ["first.ts", "second.ts"],
      initialSelectedPaths: ["first.ts"],
      onSelectionChange(selected) {
        if (!intent.shouldOpenSelection() || selected.length === 0) return;
        opened.push(selected.at(-1));
      },
    });

    intent.runProgrammaticSelection(() => {
      tree.getItem("first.ts")?.deselect();
      tree.getItem("second.ts")?.select();
    });

    expect(opened).toEqual([]);

    tree.getItem("first.ts")?.select();
    expect(opened).toEqual(["first.ts"]);
  });
});
