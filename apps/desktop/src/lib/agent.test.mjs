import { describe, expect, test } from "bun:test";
import {
  buildAutomationResumeCommand,
  buildAutomationResumeShellArgs,
  buildLaunchCommand,
} from "./agent.ts";

describe("global automation commands", () => {
  test("starts the normal interactive provider TUI with the automation prompt", () => {
    expect(
      buildLaunchCommand("codex", "--yolo", "do today's work", {
        CODEX_HOME: "/tmp/codex home",
      }),
    ).toBe(
      "CODEX_HOME='/tmp/codex home' codex --yolo 'do today'\\''s work'\n",
    );
    expect(buildLaunchCommand("claude", "", "daily brief")).toBe(
      "claude 'daily brief'\n",
    );
  });

  test("builds direct resume commands without an echoed shell exit", () => {
    expect(buildAutomationResumeCommand("codex", "--yolo", "session-1")).toBe(
      "codex --yolo 'resume' 'session-1'",
    );
    expect(buildAutomationResumeCommand("claude", "", "session-2")).toBe(
      "claude '--resume' 'session-2'",
    );
  });

  test("loads interactive shell configuration for direct resume commands", () => {
    expect(buildAutomationResumeShellArgs(["-l"])).toEqual(["-l", "-i"]);
    expect(buildAutomationResumeShellArgs(["--rcfile", "/tmp/rc", "-l"])).toEqual(
      ["--rcfile", "/tmp/rc", "-l", "-i"],
    );
  });
});
