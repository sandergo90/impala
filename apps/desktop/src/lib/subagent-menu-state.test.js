import { describe, expect, test } from "bun:test";
import {
  canShowSubagentMenu,
  formatSubagentAge,
  formatSubagentName,
  getSubagentTriggerState,
} from "./subagent-menu-state";

test("terminal tabs retain access to completed subagents", () => {
  expect(canShowSubagentMenu("terminal")).toBe(true);
  expect(canShowSubagentMenu("agent")).toBe(true);
  expect(canShowSubagentMenu("browser")).toBe(false);
});

test("formats compact subagent ages", () => {
  const now = 1_000_000_000;
  expect(formatSubagentAge(now - 4 * 60_000, now)).toBe("4m ago");
  expect(formatSubagentAge(now - 3 * 60 * 60_000, now)).toBe("3h ago");
  expect(formatSubagentAge(0, now)).toBe("");
});

test("formats readable subagent names", () => {
  expect(formatSubagentName("shortest_script")).toBe("Shortest script");
  expect(formatSubagentName("readme-title")).toBe("Readme title");
  expect(formatSubagentName("gitStatus")).toBe("Git Status");
  expect(formatSubagentName(" ")).toBe("Subagent");
});

describe("getSubagentTriggerState", () => {
  test("keeps completed subagents reachable after they move to previous runs", () => {
    expect(getSubagentTriggerState(0, 1)).toEqual({
      visible: true,
      count: 1,
    });
  });

  test("counts current and previous subagents", () => {
    expect(getSubagentTriggerState(2, 3)).toEqual({
      visible: true,
      count: 5,
    });
  });
});
