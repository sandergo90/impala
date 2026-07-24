import { describe, expect, test } from "bun:test";
import { getSubagentTriggerState } from "./subagent-menu-state";

describe("getSubagentTriggerState", () => {
  test("hides the trigger once a new message archives completed subagents", () => {
    expect(getSubagentTriggerState(0)).toEqual({
      visible: false,
      count: 0,
    });
  });

  test("counts only the current turn's subagents", () => {
    expect(getSubagentTriggerState(2)).toEqual({
      visible: true,
      count: 2,
    });
  });
});
