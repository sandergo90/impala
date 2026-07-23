import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@/lib/invoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openInSystemBrowser } from "@tauri-apps/plugin-shell";
import { useUIStore } from "../store";
import { setBrowserLeafUrl, getBrowserLeafUrl } from "../lib/tab-actions";
import {
  PICKER_ARM,
  PICKER_DISARM,
  PICKER_POLL,
  cropScreenshot,
  type BrowserPick,
} from "../lib/browser-picker";
import {
  AGENT_ACTIVITY_LABELS,
  useBrowserAgentActivity,
} from "../hooks/useBrowserAgentActivity";

const DEFAULT_URL = "about:blank";

// Superset-style omnibox semantics, minus the search-engine fallback — this
// is a dev-preview pane, not a general browser. `0.0.0.0` binds are rewritten
// to localhost so the resulting URL is actually reachable.
export function sanitizeUrl(raw: string): string {
  const input = raw.trim();
  if (!input) return DEFAULT_URL;
  if (/^(https?:\/\/|about:)/i.test(input)) {
    return input.replace(/^(https?:\/\/)0\.0\.0\.0/i, "$1localhost");
  }
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d{1,5})?([/?#].*)?$/i.test(input)) {
    return `http://${input.replace(/^0\.0\.0\.0/i, "localhost")}`;
  }
  if (input.includes(".")) return `https://${input}`;
  return input;
}

/**
 * One browser pane. The web content is a NATIVE child webview (Rust
 * `browser_*` commands, label `browser-{paneId}`) floating above the DOM —
 * this component renders only the toolbar and a placeholder div, and mirrors
 * the placeholder's rect to the webview. The webview outlives this component:
 * unmount hides it, `closeUserTab` destroys it. Keyed by the leaf/pane id so a
 * tab can hold several browser panes side by side.
 */
export const BrowserPane = memo(function BrowserPane({
  paneId,
  tabId,
  worktreePath,
  url,
  isActive,
  isFocused,
}: {
  paneId: string;
  tabId: string;
  worktreePath: string;
  url?: string;
  isActive: boolean;
  isFocused: boolean;
}) {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const createdRef = useRef(false);
  const inputFocusedRef = useRef(false);
  const [inputValue, setInputValue] = useState(url ?? "");
  const [loading, setLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // Last failed browser_* invoke, shown as a strip under the toolbar. Cleared
  // on the next successful navigation event.
  const [lastError, setLastError] = useState<string | null>(null);
  // Element annotation mode: armed picker in the page -> pick -> comment strip.
  const [annotating, setAnnotating] = useState(false);
  const [pendingPick, setPendingPick] = useState<BrowserPick | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  // The native webview is created lazily on the first real URL. A webview at
  // about:blank is invisible anyway (tauri-runtime-wry skips with_url for
  // about:blank, and wry webviews draw no background), so an empty tab
  // renders a DOM empty state instead of a transparent native view.
  const hasUrl = Boolean(url);

  // Occlusion: the native webview composites ABOVE the entire DOM, so
  // anything that must draw over the pane region hides it instead. Diff
  // mode and worktree switches are already encoded in `isActive`
  // (MainView nulls activeWorktreePath outside terminal mode).
  const paletteOpen = useUIStore((s) => s.commandPaletteOpen);
  const finderOpen = useUIStore((s) => s.fileFinderOpen);
  const terminalMenuOpen = useUIStore((s) => s.terminalMenuOpen);
  const occlusionActive = useUIStore((s) => s.panelDragActive);
  const visible =
    isActive &&
    !paletteOpen &&
    !finderOpen &&
    !terminalMenuOpen &&
    !occlusionActive;
  const { active: agentActive, kind: agentKind } =
    useBrowserAgentActivity(worktreePath);
  // Read by the async browser_open callback, which may resolve after
  // visibility already changed (or after unmount).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const persistUrl = useCallback(
    (next: string) => {
      setBrowserLeafUrl(worktreePath, tabId, paneId, next);
    },
    [worktreePath, tabId, paneId],
  );

  const syncBounds = useCallback(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    // Viewport coords ARE window-logical coords: the main webview fills the
    // window (titleBarStyle Overlay) and the app never scrolls the body.
    invoke("browser_set_bounds", {
      id: paneId,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    }).catch(() => {});
  }, [paneId]);

  useLayoutEffect(() => {
    if (!hasUrl) return;
    const el = placeholderRef.current;
    if (!el) return;
    let disposed = false;
    const r = el.getBoundingClientRect();
    invoke("browser_open", {
      id: paneId,
      worktreePath,
      // hasUrl guards this effect; on the flip from empty state this closure
      // re-runs with the freshly navigated url.
      url,
      x: r.x,
      y: r.y,
      width: Math.max(r.width, 1),
      height: Math.max(r.height, 1),
    })
      .then(() => {
        createdRef.current = true;
        setOpenError(null);
        if (disposed || !visibleRef.current) {
          // Creation resolved after unmount/occlusion — the webview was
          // created visible; hide it before it covers the wrong content.
          invoke("browser_set_visible", { id: paneId, visible: false }).catch(
            () => {},
          );
          return;
        }
        // Nudge bounds after create — works around a race where the child
        // webview first paints before the placeholder has its final rect.
        requestAnimationFrame(syncBounds);
      })
      .catch((e) => setOpenError(String(e)));

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(syncBounds);
    });
    ro.observe(el);
    window.addEventListener("resize", syncBounds);
    return () => {
      disposed = true;
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
      cancelAnimationFrame(raf);
      // Hide, never close — the webview survives tab switches; closeUserTab
      // owns destruction.
      invoke("browser_set_visible", { id: paneId, visible: false }).catch(
        () => {},
      );
    };
    // url intentionally omitted: it changes on every navigation, but the
    // webview is created once (hasUrl only ever flips false -> true) and
    // navigates itself from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, hasUrl, syncBounds]);

  useEffect(() => {
    if (!createdRef.current) return;
    invoke("browser_set_visible", { id: paneId, visible }).catch(() => {});
    if (visible) syncBounds();
  }, [visible, paneId, syncBounds]);

  // Self-heal: attaching the docked Web Inspector (right-click → Inspect
  // Element) makes WebKit resize the child webview to fill the window, and
  // nothing observable fires when it does. Re-assert the placeholder bounds
  // on a slow cadence while visible so the webview snaps back into its pane.
  // Never runs while hidden — that would un-park an offscreen webview.
  useEffect(() => {
    if (!visible || !hasUrl) return;
    const t = setInterval(syncBounds, 1000);
    return () => clearInterval(t);
  }, [visible, hasUrl, syncBounds]);

  useEffect(() => {
    let unlistenNav: UnlistenFn | undefined;
    let unlistenLoading: UnlistenFn | undefined;
    let cancelled = false;
    listen<string>(`browser-nav-${paneId}`, (event) => {
      persistUrl(event.payload);
      setLastError(null);
      // The picker dies with the old page; drop any in-progress annotation.
      setAnnotating(false);
      setPendingPick(null);
      if (!inputFocusedRef.current) setInputValue(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenNav = fn;
    });
    listen<boolean>(`browser-loading-${paneId}`, (event) => {
      setLoading(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenLoading = fn;
    });
    return () => {
      cancelled = true;
      unlistenNav?.();
      unlistenLoading?.();
    };
  }, [paneId, persistUrl]);

  const navigate = useCallback(
    (raw: string) => {
      const url = sanitizeUrl(raw);
      if (url === DEFAULT_URL) return;
      setInputValue(url);
      persistUrl(url);
      // First navigation from the empty state: the webview doesn't exist yet;
      // persisting the URL flips `hasUrl` and the layout effect creates it.
      if (createdRef.current) {
        invoke("browser_navigate", { id: paneId, url }).catch((e) =>
          setLastError(String(e)),
        );
      }
    },
    [paneId, persistUrl],
  );

  const toggleAnnotate = useCallback(() => {
    if (annotating) {
      setAnnotating(false); // the polling effect's cleanup sends the disarm
      return;
    }
    invoke("browser_eval", { id: paneId, js: PICKER_ARM })
      .then(() => setAnnotating(true))
      .catch((e) => setLastError(String(e)));
  }, [annotating, paneId]);

  useEffect(() => {
    if (!annotating) return;
    const iv = setInterval(() => {
      invoke<string>("browser_eval", { id: paneId, js: PICKER_POLL })
        .then((raw) => {
          const pick = JSON.parse(raw) as BrowserPick | null;
          if (!pick) return;
          setAnnotating(false);
          if (!pick.cancelled) setPendingPick(pick);
        })
        .catch(() => {});
    }, 200);
    return () => {
      clearInterval(iv);
      // Harmless if the picker already self-disarmed on pick/Escape; covers
      // toggle-off, tab unmount, and navigation.
      invoke("browser_eval", { id: paneId, js: PICKER_DISARM }).catch(() => {});
    };
  }, [annotating, paneId]);

  const cancelPendingPick = useCallback(() => {
    setPendingPick(null);
    setComment("");
  }, []);

  const savePendingPick = useCallback(async () => {
    if (!pendingPick || !comment.trim() || saving) return;
    setSaving(true);
    try {
      let screenshotBase64: string | undefined;
      try {
        const full = await invoke<string>("browser_screenshot", { id: paneId });
        const width = placeholderRef.current?.getBoundingClientRect().width ?? 0;
        screenshotBase64 = await cropScreenshot(full, pendingPick.rect, width);
      } catch {
        // Annotation without a screenshot beats no annotation.
        screenshotBase64 = undefined;
      }
      await invoke("create_browser_annotation", {
        annotation: {
          repo_path: worktreePath,
          url: pendingPick.url,
          selector: pendingPick.selector,
          element: pendingPick.element,
          body: comment.trim(),
        },
        screenshotBase64,
      });
      setPendingPick(null);
      setComment("");
    } catch (e) {
      setLastError(String(e));
    } finally {
      setSaving(false);
    }
  }, [pendingPick, comment, saving, paneId, worktreePath]);

  const currentUrl = url ?? DEFAULT_URL;

  return (
    <div className="flex flex-col h-full">
      {/* Pane focus reads as accent fill + border step, matching the terminal
          leaf. `--primary` is reserved for agent activity (the webview frame
          and the Agent chip) so the two never compete. */}
      <div
        className={`flex shrink-0 items-center gap-1 px-2 py-1.5 border-b transition-colors ${
          isFocused
            ? "border-border bg-accent/50"
            : "border-border/40 bg-sidebar"
        }`}
      >
        <button
          onClick={() =>
            invoke("browser_history", { id: paneId, direction: "back" }).catch(
              () => {},
            )
          }
          className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Back"
          title="Back"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 3L5 8L10 13"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          onClick={() =>
            invoke("browser_history", {
              id: paneId,
              direction: "forward",
            }).catch(() => {})
          }
          className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Forward"
          title="Forward"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M6 3L11 8L6 13"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          onClick={() =>
            invoke("browser_reload", { id: paneId }).catch((e) =>
              setLastError(String(e)),
            )
          }
          className={`size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            loading
              ? "animate-pulse motion-reduce:animate-none motion-reduce:opacity-60"
              : ""
          }`}
          aria-label="Reload"
          title="Reload"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onFocus={(e) => {
            inputFocusedRef.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            inputFocusedRef.current = false;
            // Read the latest persisted URL from this pane's leaf — the render
            // closure's `url` prop is stale right after an Enter-triggered
            // navigate, which would visibly revert the bar to the old URL.
            const latest = getBrowserLeafUrl(worktreePath, tabId, paneId);
            setInputValue(latest ?? "");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              navigate(inputValue);
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder="localhost:3000"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-sm font-mono outline-none"
        />
        <button
          onClick={() => {
            if (currentUrl !== DEFAULT_URL) {
              openInSystemBrowser(currentUrl).catch(() => {});
            }
          }}
          className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Open in system browser"
          title="Open in system browser"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M6.5 3.5H3.5A1 1 0 0 0 2.5 4.5v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5M9.5 2.5h4v4M13.5 2.5L7.5 8.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          onClick={toggleAnnotate}
          disabled={!hasUrl}
          className={`size-7 flex items-center justify-center rounded-md hover:bg-accent disabled:opacity-40 transition-colors ${
            annotating
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          aria-label="Annotate an element"
          title="Annotate an element — click one in the page, Esc to cancel"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M8 1v3M8 12v3M1 8h3M12 8h3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {agentActive && (
          <span
            className="flex shrink-0 items-center rounded bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary animate-pulse motion-reduce:animate-none"
            title={`Agent is ${AGENT_ACTIVITY_LABELS[agentKind ?? ""] ?? "using the browser"}`}
          >
            Agent
          </span>
        )}
      </div>
      {pendingPick && (
        <div className="flex shrink-0 items-center gap-2 px-2 py-1.5 border-b border-border/40 bg-sidebar">
          <span
            className="shrink-0 max-w-[220px] truncate text-xs font-mono text-muted-foreground"
            title={pendingPick.selector}
          >
            {pendingPick.selector}
          </span>
          <input
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                savePendingPick();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelPendingPick();
              }
            }}
            placeholder="Annotate this element…"
            className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-sm outline-none"
          />
          <button
            onClick={savePendingPick}
            disabled={!comment.trim() || saving}
            className="px-2 py-1 text-sm rounded bg-primary text-primary-foreground disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={cancelPendingPick}
            className="px-2 py-1 text-sm text-muted-foreground hover:text-foreground rounded hover:bg-accent"
          >
            Cancel
          </button>
        </div>
      )}
      {lastError && (
        <div className="shrink-0 px-2 py-1 text-xs text-destructive border-b border-border/40 bg-sidebar truncate">
          {lastError}
        </div>
      )}
      {/* The 2px frame is permanent (the webview is bounds-synced to the
          INNER div) so toggling the ring color never resizes the page —
          a viewport resize would trigger reflow/media queries on every
          agent-activity blip. */}
      <div
        className={`relative flex-1 min-h-0 border-2 transition-colors ${
          agentActive ? "border-primary/60" : "border-transparent"
        }`}
      >
      <div ref={placeholderRef} className="relative h-full w-full bg-background">
        {/* The native webview floats over this div. Content here is only
            visible before creation, on error, or while the webview is hidden. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          {openError ? (
            <span className="px-4 text-center">
              Failed to open browser view: {openError}
            </span>
          ) : !hasUrl ? (
            <span>Enter a URL above to preview</span>
          ) : loading ? (
            <span>Loading…</span>
          ) : null}
        </div>
      </div>
      </div>
    </div>
  );
});
