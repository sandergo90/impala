import { expect, test } from "bun:test";
import { applyEqualSplitLayouts } from "./SplitTreeRenderer.tsx";

const group = (id) => ({ type: "group", id, tabs: [], activeTabId: "" });

test("equalizing splits updates every mounted panel group", () => {
  const tree = {
    type: "split",
    orientation: "vertical",
    ratio: 0.2,
    first: {
      type: "split",
      orientation: "vertical",
      ratio: 0.8,
      first: group("left"),
      second: group("center"),
    },
    second: group("right"),
  };
  const layouts = [];
  const ratios = [];
  const splitGroups = new Map([
    ["center", { setLayout: (layout) => layouts.push(layout) }],
    ["right", { setLayout: (layout) => layouts.push(layout) }],
  ]);

  applyEqualSplitLayouts(tree, splitGroups, (splitId, ratio) => {
    ratios.push({ splitId, ratio });
  });

  expect(layouts).toEqual([
    { "center:a": 50, "center:b": 50 },
    { "right:a": (2 / 3) * 100, "right:b": (1 - 2 / 3) * 100 },
  ]);
  expect(ratios).toEqual([
    { splitId: "center", ratio: 0.5 },
    { splitId: "right", ratio: 2 / 3 },
  ]);
});
