import { describe, expect, test } from "bun:test";
import { parseNativeAutomationTranscript } from "./native-automation-transcript.ts";

describe("parseNativeAutomationTranscript", () => {
  test("keeps user, agent, command, and turn status information", () => {
    expect(parseNativeAutomationTranscript({
      thread: {
        turns: [{
          status: "completed",
          items: [
            { type: "userMessage", content: [{ text: "Fix the test" }] },
            { type: "agentMessage", text: "I found the cause." },
            { type: "commandExecution", command: "cargo test", aggregatedOutput: "ok", exitCode: 0, status: "completed" },
            { type: "mcpToolCall", server: "impala", tool: "read_file", status: "completed", arguments: { path: "src/lib.rs" }, result: { ok: true } },
            { type: "fileChange", status: "completed", changes: [{ kind: { type: "update", movePath: null }, path: "src/lib.rs" }] },
          ],
        }],
      },
    })).toEqual([
      { kind: "user", text: "Fix the test" },
      { kind: "agent", text: "I found the cause." },
      { kind: "tool", text: "$ cargo test (completed) -- exit 0\nok" },
      { kind: "tool", text: "impala/read_file (completed)" },
      { kind: "tool", text: "Files changed (completed)\nupdate src/lib.rs" },
      { kind: "status", text: "Turn completed" },
    ]);
  });
});
