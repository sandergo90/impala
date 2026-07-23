import { describe, expect, test } from "bun:test";
import { isTerminalInterruptInput } from "./terminal-input.ts";

describe("isTerminalInterruptInput", () => {
  test("recognizes Ctrl+C without treating ordinary terminal input as an interrupt", () => {
    expect(isTerminalInterruptInput("\x03")).toBe(true);
    expect(isTerminalInterruptInput("c")).toBe(false);
    expect(isTerminalInterruptInput("\r")).toBe(false);
  });
});
