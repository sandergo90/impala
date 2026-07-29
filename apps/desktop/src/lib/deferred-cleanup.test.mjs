import { describe, expect, test } from "bun:test";
import { createDeferredCleanupScheduler } from "./deferred-cleanup.ts";

describe("createDeferredCleanupScheduler", () => {
  test("ignores Strict Mode's probe cleanup but runs a real unmount cleanup", () => {
    const microtasks = [];
    const scheduler = createDeferredCleanupScheduler((task) => {
      microtasks.push(task);
    });
    let releases = 0;

    scheduler.cancelPendingCleanup(); // effect setup
    scheduler.scheduleCleanup(() => releases++); // Strict Mode probe cleanup
    scheduler.cancelPendingCleanup(); // Strict Mode second setup
    microtasks.splice(0).forEach((task) => task());
    expect(releases).toBe(0);

    scheduler.scheduleCleanup(() => releases++); // real unmount
    microtasks.splice(0).forEach((task) => task());
    expect(releases).toBe(1);
  });
});
