import { describe, expect, test } from "bun:test";
import {
  buildAutomationResumeCommand,
  buildDirectLaunchCommand,
  buildInteractiveShellArgs,
  buildLaunchCommand,
} from "./agent.ts";

const CODEX_ENV = {
  IMPALA_CODEX_APP_SERVER: "unix:///tmp/impala-codex.sock",
  IMPALA_CODEX_APP_SERVER_LOG: "/tmp/impala-codex.log",
};

describe("global automation commands", () => {
  test("starts the normal interactive provider TUI with the automation prompt", () => {
    expect(
      buildLaunchCommand("codex", "--yolo", "do today's work", {
        ...CODEX_ENV,
        CODEX_HOME: "/tmp/codex home",
      }),
    ).toBe(
      "(codex app-server --listen 'unix:///tmp/impala-codex.sock' >>'/tmp/impala-codex.log' 2>&1 & IMPALA_CODEX_SERVER_PID=$!; trap 'kill \"$IMPALA_CODEX_SERVER_PID\" 2>/dev/null' EXIT HUP TERM; sleep 0.1; for _ in {1..100}; do [ -S '/tmp/impala-codex.sock' ] && break; sleep 0.05; done; IMPALA_CODEX_APP_SERVER='unix:///tmp/impala-codex.sock' IMPALA_CODEX_APP_SERVER_LOG='/tmp/impala-codex.log' CODEX_HOME='/tmp/codex home' codex --remote 'unix:///tmp/impala-codex.sock' --yolo 'do today'\\''s work')\n",
    );
    expect(buildLaunchCommand("claude", "", "daily brief")).toBe(
      "claude 'daily brief'\n",
    );
  });

  test("applies shell-safe per-tab Codex configuration", () => {
    expect(
      buildLaunchCommand("codex", "--yolo", "$implement the ticket", CODEX_ENV, {
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        serviceTier: "fast",
      }),
    ).toBe(
      "(codex app-server --listen 'unix:///tmp/impala-codex.sock' >>'/tmp/impala-codex.log' 2>&1 & IMPALA_CODEX_SERVER_PID=$!; trap 'kill \"$IMPALA_CODEX_SERVER_PID\" 2>/dev/null' EXIT HUP TERM; sleep 0.1; for _ in {1..100}; do [ -S '/tmp/impala-codex.sock' ] && break; sleep 0.05; done; IMPALA_CODEX_APP_SERVER='unix:///tmp/impala-codex.sock' IMPALA_CODEX_APP_SERVER_LOG='/tmp/impala-codex.log' codex --remote 'unix:///tmp/impala-codex.sock' --yolo '-m' 'gpt-5.6-luna' '-c' 'model_reasoning_effort=max' '-c' 'service_tier=fast' '$implement the ticket')\n",
    );
    expect(
      buildLaunchCommand("codex", "--yolo", "prompt", CODEX_ENV, {
        model: "model'; echo unsafe",
      }),
    ).toBe(
      "(codex app-server --listen 'unix:///tmp/impala-codex.sock' >>'/tmp/impala-codex.log' 2>&1 & IMPALA_CODEX_SERVER_PID=$!; trap 'kill \"$IMPALA_CODEX_SERVER_PID\" 2>/dev/null' EXIT HUP TERM; sleep 0.1; for _ in {1..100}; do [ -S '/tmp/impala-codex.sock' ] && break; sleep 0.05; done; IMPALA_CODEX_APP_SERVER='unix:///tmp/impala-codex.sock' IMPALA_CODEX_APP_SERVER_LOG='/tmp/impala-codex.log' codex --remote 'unix:///tmp/impala-codex.sock' --yolo '-m' 'model'\\''; echo unsafe' 'prompt')\n",
    );
  });

  test("leaves the inherited Codex home untouched", () => {
    const command = buildLaunchCommand("codex", "--yolo", "prompt", CODEX_ENV);
    expect(command).not.toContain("CODEX_HOME=");
    expect(command).not.toContain(".impala/codex");
  });

  test("builds delegated multiline prompts as a direct PTY command", () => {
    expect(
      buildDirectLaunchCommand(
        "codex",
        "--yolo",
        "Read the ticket fully.\n\nImplement it.",
        CODEX_ENV,
        { model: "gpt-5.6-luna", reasoningEffort: "max" },
      ),
    ).toBe(
      "(codex app-server --listen 'unix:///tmp/impala-codex.sock' >>'/tmp/impala-codex.log' 2>&1 & IMPALA_CODEX_SERVER_PID=$!; trap 'kill \"$IMPALA_CODEX_SERVER_PID\" 2>/dev/null' EXIT HUP TERM; sleep 0.1; for _ in {1..100}; do [ -S '/tmp/impala-codex.sock' ] && break; sleep 0.05; done; IMPALA_CODEX_APP_SERVER='unix:///tmp/impala-codex.sock' IMPALA_CODEX_APP_SERVER_LOG='/tmp/impala-codex.log' codex --remote 'unix:///tmp/impala-codex.sock' --yolo '-m' 'gpt-5.6-luna' '-c' 'model_reasoning_effort=max' 'Read the ticket fully.\n\nImplement it.')",
    );
  });

  test("builds direct resume commands without an echoed shell exit", () => {
    expect(buildAutomationResumeCommand("codex", "--yolo", "session-1", CODEX_ENV)).toBe(
      "(codex app-server --listen 'unix:///tmp/impala-codex.sock' >>'/tmp/impala-codex.log' 2>&1 & IMPALA_CODEX_SERVER_PID=$!; trap 'kill \"$IMPALA_CODEX_SERVER_PID\" 2>/dev/null' EXIT HUP TERM; sleep 0.1; for _ in {1..100}; do [ -S '/tmp/impala-codex.sock' ] && break; sleep 0.05; done; IMPALA_CODEX_APP_SERVER='unix:///tmp/impala-codex.sock' IMPALA_CODEX_APP_SERVER_LOG='/tmp/impala-codex.log' codex --remote 'unix:///tmp/impala-codex.sock' --yolo 'resume' 'session-1')",
    );
    expect(buildAutomationResumeCommand("claude", "", "session-2")).toBe(
      "claude '--resume' 'session-2'",
    );
  });

  test("preserves an explicitly configured Codex remote", () => {
    expect(
      buildLaunchCommand(
        "codex",
        "--remote ws://127.0.0.1:4222",
        "prompt",
        CODEX_ENV,
      ),
    ).toBe(
      "IMPALA_CODEX_APP_SERVER='unix:///tmp/impala-codex.sock' IMPALA_CODEX_APP_SERVER_LOG='/tmp/impala-codex.log' IMPALA_CODEX_APP_SERVER='' codex --remote ws://127.0.0.1:4222 'prompt'\n",
    );
  });

  test("loads interactive shell configuration for direct resume commands", () => {
    expect(buildInteractiveShellArgs(["-l"])).toEqual(["-l", "-i"]);
    expect(buildInteractiveShellArgs(["--rcfile", "/tmp/rc", "-l"])).toEqual(
      ["--rcfile", "/tmp/rc", "-l", "-i"],
    );
  });
});
