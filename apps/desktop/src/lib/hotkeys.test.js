import { describe, expect, test } from "bun:test";
import { migrateHotkeyOverrides } from "./hotkeys.ts";

describe("hotkey override migrations", () => {
  test("preserves legacy Changes bindings without reclaiming Ctrl+2", () => {
    expect(
      migrateHotkeyOverrides({ SWITCH_TAB_DIFF: "ctrl+8" }),
    ).toEqual({ SWITCH_TAB_DIFF: "ctrl+8" });
    expect(
      migrateHotkeyOverrides({ SWITCH_TAB_TERMINAL: "ctrl+2" }),
    ).toEqual({
      SWITCH_TAB_TERMINAL: "ctrl+2",
      SWITCH_TAB_DIFF: null,
    });
  });
});
