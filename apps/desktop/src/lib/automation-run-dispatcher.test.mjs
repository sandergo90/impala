import { describe, expect, test } from "bun:test";
import { createAutomationRunDispatcher } from "./automation-run-dispatcher.ts";

describe("createAutomationRunDispatcher", () => {
  test("launches a run only once when live delivery and startup recovery overlap", () => {
    const launched = [];
    const dispatch = createAutomationRunDispatcher((run) => {
      launched.push(run.run_id);
    });

    dispatch({ run_id: "run-1" });
    dispatch({ run_id: "run-1" });
    dispatch({ run_id: "run-2" });

    expect(launched).toEqual(["run-1", "run-2"]);
  });
});
