import { describe, expect, test } from "bun:test";
import { AGENT_PANE_ID, RUN_PANE_ID } from "./pane-ids";
import {
  getPaneBodyKey,
  getWorkspaceRendererKey,
} from "./workspace-renderer-key.ts";

describe("getWorkspaceRendererKey", () => {
  test("keeps the shared Run and Agent split renderer mounted", () => {
    expect(getWorkspaceRendererKey(RUN_PANE_ID, false)).toBe(
      getWorkspaceRendererKey(AGENT_PANE_ID, false),
    );
  });

  test("keeps independent user-tab renderers isolated", () => {
    expect(getWorkspaceRendererKey("terminal-1", true)).not.toBe(
      getWorkspaceRendererKey("terminal-2", true),
    );
  });

  test("remounts the terminal body when the displayed pane changes", () => {
    expect(getPaneBodyKey(AGENT_PANE_ID, RUN_PANE_ID)).not.toBe(
      getPaneBodyKey(AGENT_PANE_ID),
    );
  });
});
