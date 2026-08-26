import { describe, expect, test } from "bun:test";
import {
  groupNativeAutomationTranscript,
  parseNativeAutomationTranscript,
} from "./native-automation-transcript.ts";

describe("native automation transcript", () => {
  test("keeps structured user, agent, tool, and turn status information", () => {
    expect(parseNativeAutomationTranscript({
      thread: {
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [
            { id: "user-1", type: "userMessage", content: [{ text: "Fix the test" }] },
            { id: "agent-1", type: "agentMessage", text: "I found the cause." },
            { id: "command-1", type: "commandExecution", command: "cargo test", aggregatedOutput: "ok", exitCode: 0, status: "completed" },
            { id: "mcp-1", type: "mcpToolCall", server: "impala", tool: "read_file", status: "completed", arguments: { path: "src/lib.rs" }, result: { ok: true } },
            { id: "file-1", type: "fileChange", status: "completed", changes: [{ kind: { type: "update", movePath: null }, path: "src/lib.rs" }] },
          ],
        }],
      },
    })).toEqual([
      { id: "item:user-1", kind: "user", text: "Fix the test" },
      { id: "item:agent-1", kind: "agent", text: "I found the cause.", isTurnResult: true },
      { id: "item:command-1", kind: "tool", activity: "command", summary: "$ cargo test", status: "completed", exitCode: 0, details: "ok" },
      { id: "item:mcp-1", kind: "tool", activity: "mcp", summary: "impala/read_file", status: "completed", details: "Arguments\n{\n  \"path\": \"src/lib.rs\"\n}\n\nResult\n{\n  \"ok\": true\n}" },
      { id: "item:file-1", kind: "tool", activity: "file", summary: "Files changed", status: "completed", details: "update src/lib.rs" },
      { id: "item:turn-1:status", kind: "status", text: "Turn completed" },
    ]);
  });

  test("supports snake_case items and deterministic fallback identities", () => {
    expect(parseNativeAutomationTranscript({
      thread: {
        turns: [{
          items: [
            { type: "user_message", text: "Inspect this" },
            { type: "agent_message", text: "Done" },
            { type: "command_execution", command: "bun test", output: "pass" },
            { type: "mcp_tool_call", server: "impala", tool: "read" },
            { type: "file_change", changes: [{ kind: "create", path: "notes.md" }] },
          ],
        }],
      },
    })).toEqual([
      { id: "turn:0:item:0", kind: "user", text: "Inspect this" },
      { id: "turn:0:item:1", kind: "agent", text: "Done", isTurnResult: true },
      { id: "turn:0:item:2", kind: "tool", activity: "command", summary: "$ bun test", details: "pass" },
      { id: "turn:0:item:3", kind: "tool", activity: "mcp", summary: "impala/read" },
      { id: "turn:0:item:4", kind: "tool", activity: "file", summary: "Files changed", details: "create notes.md" },
    ]);
  });

  test("groups a reasoning summary with its following tool burst", () => {
    const entries = parseNativeAutomationTranscript({
      thread: {
        turns: [{
          items: [
            { id: "reason-1", type: "reasoning", summary: ["Preparing", "**Planning app integration**"] },
            { id: "command-1", type: "commandExecution", command: "bun test", status: "completed" },
            { id: "command-2", type: "commandExecution", command: "bun run typecheck", status: "completed" },
            { id: "agent-1", type: "agentMessage", text: "The contract is clear." },
          ],
        }],
      },
    });

    expect(groupNativeAutomationTranscript(entries)).toEqual([
      {
        id: "activity:item:reason-1",
        kind: "activity",
        title: "**Planning app integration**",
        tools: [
          { id: "item:command-1", kind: "tool", activity: "command", summary: "$ bun test", status: "completed" },
          { id: "item:command-2", kind: "tool", activity: "command", summary: "$ bun run typecheck", status: "completed" },
        ],
      },
      { id: "item:agent-1", kind: "agent", text: "The contract is clear.", isTurnResult: true },
    ]);
  });
});
