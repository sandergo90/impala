import { describe, expect, test } from "bun:test";
import {
  buildAutomationResumeCommand,
  buildAutomationRunCommand,
} from "./agent.ts";

describe("global automation commands", () => {
  test("runs Codex once and exits the PTY shell", () => {
    expect(
      buildAutomationRunCommand("codex", "--yolo", "do today's work", {
        CODEX_HOME: "/tmp/codex home",
      }),
    ).toBe(
      "CODEX_HOME='/tmp/codex home' codex --yolo 'exec' 'do today'\\''s work'; exit\n",
    );
  });

  test("runs Claude in noninteractive text mode and exits the PTY shell", () => {
    expect(buildAutomationRunCommand("claude", "", "daily brief")).toBe(
      "claude '--print' '--output-format' 'text' 'daily brief'; exit\n",
    );
  });

  test("resumes each provider interactively and closes the shell afterward", () => {
    expect(buildAutomationResumeCommand("codex", "--yolo", "session-1")).toBe(
      "codex --yolo 'resume' 'session-1'; exit\n",
    );
    expect(buildAutomationResumeCommand("claude", "", "session-2")).toBe(
      "claude '--resume' 'session-2'; exit\n",
    );
  });
});
