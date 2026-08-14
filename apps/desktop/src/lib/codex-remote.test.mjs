import { describe, expect, test } from "bun:test";
import { codexRemotePairingUrl } from "./codex-remote.ts";

describe("Codex Remote pairing", () => {
  test("wraps the opaque pairing token in the ChatGPT Codex pairing URL", () => {
    expect(codexRemotePairingUrl("token with +/?&")).toBe(
      "https://chatgpt.com/codex/pair?pairing_code=token+with+%2B%2F%3F%26",
    );
  });
});
