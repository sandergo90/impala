import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useUIStore } from "../store";
import { runPtySessionId } from "../lib/pane-ids";
import { sanitizeEventId } from "../lib/sanitize-event-id";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const DEV_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"')\]]*)?/i;
// PTY chunks can split a URL across frames; keep this much trailing context.
const TAIL_CHARS = 256;

/** Exported for direct testing — pure text-in, url-or-null-out. */
export function extractDevServerUrl(text: string): string | null {
  const m = text.replace(ANSI_RE, "").match(DEV_URL_RE);
  if (!m) return null;
  // Trailing punctuation is almost always prose, not path ("...at
  // http://localhost:3000."). Unreachable bind addresses become localhost.
  return m[0]
    .replace(/[.,;:!?]+$/, "")
    .replace(/\/\/(0\.0\.0\.0|\[::\])/, "//localhost");
}

/**
 * Watches the Run tab's PTY output for a dev-server URL and parks it on
 * `WorktreeNavState.detectedDevServerUrl` (cleared when the Run PTY exits).
 * Scoped to the Run session only — dev servers started in ad-hoc terminal
 * tabs are not sniffed; the browser tab's URL bar covers those.
 */
export function useDevServerDetection(
  worktreePath: string,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const safeId = sanitizeEventId(runPtySessionId(worktreePath));
    let tail = "";
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let cancelled = false;

    listen<string>(`pty-output-${safeId}`, (event) => {
      let decoded = "";
      try {
        decoded = atob(event.payload);
      } catch {
        return;
      }
      const text = tail + decoded;
      tail = text.slice(-TAIL_CHARS);
      const url = extractDevServerUrl(text);
      if (!url) return;
      const uiState = useUIStore.getState();
      if (uiState.getWorktreeNavState(worktreePath).detectedDevServerUrl !== url) {
        uiState.updateWorktreeNavState(worktreePath, {
          detectedDevServerUrl: url,
        });
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenOutput = fn;
      })
      .catch(() => {});

    listen<number>(`pty-exit-${safeId}`, () => {
      tail = "";
      const uiState = useUIStore.getState();
      if (uiState.getWorktreeNavState(worktreePath).detectedDevServerUrl) {
        uiState.updateWorktreeNavState(worktreePath, {
          detectedDevServerUrl: null,
        });
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenExit = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlistenOutput?.();
      unlistenExit?.();
    };
  }, [worktreePath, enabled]);
}
