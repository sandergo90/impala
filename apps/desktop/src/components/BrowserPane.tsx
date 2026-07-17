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
import type { UserTab } from "../types";

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
 * Browser tab body. The web content is a NATIVE child webview (Rust
 * `browser_*` commands, label `browser-{tab.id}`) floating above the DOM —
 * this component renders only the toolbar and a placeholder div, and mirrors
 * the placeholder's rect to the webview. The webview outlives this component:
 * unmount hides it, `closeUserTab` destroys it.
 */
export const BrowserPane = memo(function BrowserPane({
  tab,
  worktreePath,
  isActive,
}: {
  tab: UserTab;
  worktreePath: string;
  isActive: boolean;
}) {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const createdRef = useRef(false);
  const inputFocusedRef = useRef(false);
  const [inputValue, setInputValue] = useState(tab.url ?? "");
  const [loading, setLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // Occlusion: the native webview composites ABOVE the entire DOM, so
  // anything that must draw over the pane region hides it instead. Diff
  // mode and worktree switches are already encoded in `isActive`
  // (MainView nulls activeWorktreePath outside terminal mode).
  const paletteOpen = useUIStore((s) => s.commandPaletteOpen);
  const finderOpen = useUIStore((s) => s.fileFinderOpen);
  const dragActive = useUIStore((s) => s.panelDragActive);
  const visible = isActive && !paletteOpen && !finderOpen && !dragActive;
  // Read by the async browser_open callback, which may resolve after
  // visibility already changed (or after unmount).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const persistUrl = useCallback(
    (url: string) => {
      const uiState = useUIStore.getState();
      const nav = uiState.getWorktreeNavState(worktreePath);
      uiState.updateWorktreeNavState(worktreePath, {
        userTabs: nav.userTabs.map((t) =>
          t.id === tab.id ? { ...t, url } : t,
        ),
      });
    },
    [worktreePath, tab.id],
  );

  const syncBounds = useCallback(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    // Viewport coords ARE window-logical coords: the main webview fills the
    // window (titleBarStyle Overlay) and the app never scrolls the body.
    invoke("browser_set_bounds", {
      id: tab.id,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    }).catch(() => {});
  }, [tab.id]);

  useLayoutEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;
    let disposed = false;
    const r = el.getBoundingClientRect();
    invoke("browser_open", {
      id: tab.id,
      url: tab.url ?? DEFAULT_URL,
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
          invoke("browser_set_visible", { id: tab.id, visible: false }).catch(
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
      invoke("browser_set_visible", { id: tab.id, visible: false }).catch(
        () => {},
      );
    };
    // tab.url intentionally omitted: it changes on every navigation, but the
    // webview is created once and navigates itself from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, syncBounds]);

  useEffect(() => {
    if (!createdRef.current) return;
    invoke("browser_set_visible", { id: tab.id, visible }).catch(() => {});
    if (visible) syncBounds();
  }, [visible, tab.id, syncBounds]);

  useEffect(() => {
    let unlistenNav: UnlistenFn | undefined;
    let unlistenLoading: UnlistenFn | undefined;
    let cancelled = false;
    listen<string>(`browser-nav-${tab.id}`, (event) => {
      persistUrl(event.payload);
      if (!inputFocusedRef.current) setInputValue(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenNav = fn;
    });
    listen<boolean>(`browser-loading-${tab.id}`, (event) => {
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
  }, [tab.id, persistUrl]);

  const navigate = useCallback(
    (raw: string) => {
      const url = sanitizeUrl(raw);
      setInputValue(url === DEFAULT_URL ? "" : url);
      persistUrl(url);
      invoke("browser_navigate", { id: tab.id, url }).catch(() => {});
    },
    [tab.id, persistUrl],
  );

  const currentUrl = tab.url ?? DEFAULT_URL;

  return (
    <div className="flex flex-col h-full">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5 border-b border-border/40 bg-sidebar">
        <button
          onClick={() =>
            invoke("browser_history", { id: tab.id, direction: "back" }).catch(
              () => {},
            )
          }
          className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
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
              id: tab.id,
              direction: "forward",
            }).catch(() => {})
          }
          className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
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
            invoke("browser_reload", { id: tab.id }).catch(() => {})
          }
          className={`p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent ${
            loading ? "animate-pulse" : ""
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
            setInputValue(currentUrl === DEFAULT_URL ? "" : currentUrl);
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
          className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-[13px] font-mono outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          onClick={() => {
            if (currentUrl !== DEFAULT_URL) {
              openInSystemBrowser(currentUrl).catch(() => {});
            }
          }}
          className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
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
      </div>
      <div ref={placeholderRef} className="relative flex-1 min-h-0 bg-background">
        {/* The native webview floats over this div. Content here is only
            visible before creation, on error, or while the webview is hidden. */}
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {openError ? (
            <span className="px-4 text-center">
              Failed to open browser view: {openError}
            </span>
          ) : (
            <span>Loading…</span>
          )}
        </div>
      </div>
    </div>
  );
});
