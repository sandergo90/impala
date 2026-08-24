import { describe, expect, test } from "bun:test";
import { codexAutomationThreadToResume } from "./automation-run-resume.ts";

const nativeCodexRun = {
  status: "completed",
  agent_transport: "app-server",
  agent_provider: "codex",
  agent_session_id: "thread-1",
};

describe("automation worktree resume", () => {
  test("resumes the exact persisted thread after a native Codex run finishes", () => {
    expect(codexAutomationThreadToResume(nativeCodexRun)).toBe("thread-1");
  });

  test("resumes the same thread while the native run is still going", () => {
    expect(
      codexAutomationThreadToResume({ ...nativeCodexRun, status: "launched" }),
    ).toBe("thread-1");
  });

  test("waits for the rollout: a pending row's thread is not resumable yet", () => {
    expect(
      codexAutomationThreadToResume({ ...nativeCodexRun, status: "pending" }),
    ).toBeUndefined();
  });

  test("does not resume CLI, non-Codex, or missing thread identities", () => {
    expect(
      codexAutomationThreadToResume({ ...nativeCodexRun, agent_transport: "cli" }),
    ).toBeUndefined();
    expect(
      codexAutomationThreadToResume({ ...nativeCodexRun, agent_provider: "claude" }),
    ).toBeUndefined();
    expect(
      codexAutomationThreadToResume({ ...nativeCodexRun, agent_session_id: null }),
    ).toBeUndefined();
  });
});
