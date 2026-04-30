import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { sanitizeEventId } from "./sanitize-event-id";

type ReadyReason = "ready" | "timed_out" | "unsupported";

interface PendingReadiness {
  promise: Promise<ReadyReason>;
  resolve: (reason: ReadyReason) => void;
  unlisten: UnlistenFn | null;
  timeoutId: number;
}

const pending = new Map<string, PendingReadiness>();

/** 1 s longer than the daemon's 15 s fallback. */
const FRONTEND_READY_TIMEOUT_MS = 16_000;

/**
 * Returns a promise that resolves once the daemon reports the shell is
 * ready (OSC 133;A observed, timed out, or unsupported). Safe to call
 * multiple times for the same sessionId — subsequent calls return the
 * same promise.
 *
 * Always resolves — never rejects. The frontend treats every reason as
 * "go ahead and write" because the daemon has already decided.
 */
export async function awaitShellReady(sessionId: string): Promise<ReadyReason> {
  const existing = pending.get(sessionId);
  if (existing) return existing.promise;

  let resolveFn: (reason: ReadyReason) => void = () => {};
  const promise = new Promise<ReadyReason>((resolve) => {
    resolveFn = resolve;
  });

  const safeId = sanitizeEventId(sessionId);
  const eventName = `pty-shell-ready-${safeId}`;

  const entry: PendingReadiness = {
    promise,
    resolve: resolveFn,
    unlisten: null,
    timeoutId: window.setTimeout(() => {
      const e = pending.get(sessionId);
      if (!e) return;
      e.unlisten?.();
      pending.delete(sessionId);
      e.resolve("timed_out");
    }, FRONTEND_READY_TIMEOUT_MS),
  };
  pending.set(sessionId, entry);

  entry.unlisten = await listen<string>(eventName, (event) => {
    const e = pending.get(sessionId);
    if (!e) return;
    window.clearTimeout(e.timeoutId);
    e.unlisten?.();
    pending.delete(sessionId);
    const reason = (event.payload as ReadyReason) ?? "ready";
    e.resolve(reason);
  });

  return promise;
}

/**
 * Pre-resolve readiness for a session we already know is ready (e.g. re-
 * attaching to a PTY that survived an app restart — its shell is well
 * past prompt-1 by now).
 */
export function markShellReady(sessionId: string): void {
  const existing = pending.get(sessionId);
  if (existing) {
    window.clearTimeout(existing.timeoutId);
    existing.unlisten?.();
    pending.delete(sessionId);
    existing.resolve("ready");
    return;
  }
  // No pending entry — install a pre-resolved one so a later awaitShellReady()
  // returns immediately without subscribing.
  let resolveFn: (reason: ReadyReason) => void = () => {};
  const p = new Promise<ReadyReason>((resolve) => {
    resolveFn = resolve;
  });
  pending.set(sessionId, {
    promise: p,
    resolve: resolveFn,
    unlisten: null,
    timeoutId: 0,
  });
  resolveFn("ready");
}
