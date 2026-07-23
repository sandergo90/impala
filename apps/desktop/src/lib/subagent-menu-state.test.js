import { describe, expect, test } from "bun:test";
import { getSubagentTriggerState } from "./subagent-menu-state";

describe("getSubagentTriggerState", () => {
  test("keeps completed Claude subagent history reachable", () => {
    expect(getSubagentTriggerState(0, 4)).toEqual({
      visible: true,
      count: 4,
      historyOnly: true,
    });
  });
});
