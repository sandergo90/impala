import { describe, expect, test } from "bun:test";
import {
  buildAutomationResumeCommand,
  buildDirectLaunchCommand,
  buildInteractiveShellArgs,
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

  test("applies shell-safe per-tab Codex configuration", () => {
    expect(
      buildLaunchCommand("codex", "--yolo", "$implement the ticket", undefined, {
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        serviceTier: "fast",
      }),
    ).toBe(
      "codex --yolo '-m' 'gpt-5.6-luna' '-c' 'model_reasoning_effort=max' '-c' 'service_tier=fast' '$implement the ticket'\n",
    );
    expect(
      buildLaunchCommand("codex", "--yolo", "prompt", undefined, {
        model: "model'; echo unsafe",
      }),
    ).toBe("codex --yolo '-m' 'model'\\''; echo unsafe' 'prompt'\n");
  });

  test("leaves the inherited Codex home untouched", () => {
    const command = buildLaunchCommand("codex", "--yolo", "prompt");
    expect(command).not.toContain("CODEX_HOME=");
    expect(command).not.toContain(".impala/codex");
  });

  test("builds delegated multiline prompts as a direct PTY command", () => {
    expect(
      buildDirectLaunchCommand(
        "codex",
        "--yolo",
        "Read the ticket fully.\n\nImplement it.",
        undefined,
        { model: "gpt-5.6-luna", reasoningEffort: "max" },
      ),
    ).toBe(
      "codex --yolo '-m' 'gpt-5.6-luna' '-c' 'model_reasoning_effort=max' 'Read the ticket fully.\n\nImplement it.'",
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
    expect(buildInteractiveShellArgs(["-l"])).toEqual(["-l", "-i"]);
    expect(buildInteractiveShellArgs(["--rcfile", "/tmp/rc", "-l"])).toEqual(
      ["--rcfile", "/tmp/rc", "-l", "-i"],
    );
  });
});
