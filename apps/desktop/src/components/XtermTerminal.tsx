import { memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { useUIStore } from "../store";
import { resolveThemeById } from "../themes/apply";
import { useAppHotkey } from "../hooks/useAppHotkey";
import { matchesHotkeyEvent } from "../lib/hotkeys";
import { useHotkeysStore } from "../stores/hotkeys";
import { createFileLinkProvider } from "../lib/terminal-link-provider";
import { encodePtyInput } from "../lib/encode-pty";
import { sanitizeEventId } from "../lib/sanitize-event-id";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
} from "./settings/FontSettingSection";

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

// Sticky global fallback: once any terminal loses its WebGL context or fails
// to init the addon, all future terminals in this session render via DOM.
let webglDisabled = false;

/**
 * Build a CSS font-family string safe for xterm.js.
 * Custom single-family names (e.g. "JetBrains Mono") must be quoted so that
 * xterm's internal canvas font shorthand (`14px JetBrains Mono`) is parsed
 * correctly. A monospace fallback is appended to avoid invisible text if the
 * font is unavailable.
 */
function toXtermFontFamily(custom: string | null): string {
  if (!custom) return DEFAULT_TERMINAL_FONT_FAMILY;
  if (custom.includes(",")) return custom;
  return `"${custom}", monospace`;
}

function getTerminalTheme() {
  const state = useUIStore.getState();
  return resolveThemeById(state.activeThemeId, state.customThemes).terminal;
}

// ---------------------------------------------------------------------------
// Cached xterm instances
//
// When the React tree that hosts a TabBody restructures (e.g. splitting a
// user tab from 1 leaf to 2 inside a ResizablePanelGroup), React unmounts
// and remounts the TabBody subtree. Without caching, each remount disposes
// the xterm Terminal and recreates it, which means:
//  - a fresh pty_resize fires SIGWINCH at the shell, and zsh draws its
//    PROMPT_EOL_MARK (`%`) before the new prompt;
//  - the buffer replay flickers;
//  - a new WebGL context is allocated and may push the other terminals
//    over the browser cap.
//
// Mirrors the superset terminal cache pattern: the wrapper <div> that xterm
// was opened on is kept alive at module level, parked on document.body when
// detached, and appendChild'd into the next host container on re-attach.
// PTY output/exit listeners and the hidden-state focus handling also live in
// the cache so they survive unmounts.
// ---------------------------------------------------------------------------

interface CachedTerminal {
  sessionId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  webglAddon: WebglAddon | null;
  wrapper: HTMLDivElement;
  linkDisposable: { dispose(): void } | null;
  onDataDisposable: { dispose(): void } | null;
  onResizeDisposable: { dispose(): void } | null;
  unlistenOutput: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  unlistenDragDrop: UnlistenFn | null;
  baseDirRef: { current: string | null };
  exitedRef: { current: boolean };
  exitCode: number | null;
  onExitHandler: ((code: number) => void) | null;
  writeQueue: Uint8Array[];
  writeScheduled: boolean;
  isFocusedRef: { current: boolean };
}

const terminalCache = new Map<string, CachedTerminal>();

function decodeBase64(encoded: string): Uint8Array {
  const binaryStr = atob(encoded);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

async function createCachedTerminal(
  sessionId: string,
  scrollback: number,
): Promise<CachedTerminal> {
  const uiState = useUIStore.getState();
  const fontFamily = toXtermFontFamily(uiState.terminalFontFamily);
  const fontSize =
    uiState.terminalFontSize ?? uiState.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE;

  const terminal = new Terminal({
    scrollback,
    cursorBlink: true,
    cursorStyle: "bar",
    fontSize,
    fontFamily,
    theme: getTerminalTheme(),
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);

  // Detached wrapper — xterm.open() mutates this div, then we appendChild it
  // into whichever component container currently hosts this session. The
  // wrapper is painted with the theme background so any transient gap
  // between xterm's canvas and the container edge during drag resizes
  // shows the same color as the canvas (no flash). `contain: strict`
  // isolates layout/paint so resize ticks don't cascade through ancestors.
  const theme = getTerminalTheme();
  const wrapper = document.createElement("div");
  wrapper.style.width = "100%";
  wrapper.style.height = "100%";
  wrapper.style.background = theme.background ?? "";
  wrapper.style.contain = "strict";
  terminal.open(wrapper);

  const baseDirRef = { current: null as string | null };
  const linkDisposable = terminal.registerLinkProvider(
    createFileLinkProvider(terminal, () => baseDirRef.current),
  );

  let webglAddon: WebglAddon | null = null;
  if (!webglDisabled) {
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglDisabled = true;
        webglAddon?.dispose();
        webglAddon = null;
      });
      terminal.loadAddon(webglAddon);
    } catch {
      webglDisabled = true;
      webglAddon = null;
    }
  }

  const entry: CachedTerminal = {
    sessionId,
    terminal,
    fitAddon,
    searchAddon,
    webglAddon,
    wrapper,
    linkDisposable,
    onDataDisposable: null,
    onResizeDisposable: null,
    unlistenOutput: null,
    unlistenExit: null,
    unlistenDragDrop: null,
    baseDirRef,
    exitedRef: { current: false },
    exitCode: null,
    onExitHandler: null,
    writeQueue: [],
    writeScheduled: false,
    isFocusedRef: { current: true },
  };

  function writeToPty(text: string) {
    if (entry.exitedRef.current) return;
    const encoded = encodePtyInput(text);
    invoke("pty_write", { sessionId, data: encoded }).catch(() => {});
  }

  entry.onDataDisposable = terminal.onData((data: string) => writeToPty(data));
  entry.onResizeDisposable = terminal.onResize(({ cols, rows }) => {
    if (entry.exitedRef.current) return;
    invoke("pty_resize", { sessionId, rows, cols }).catch(() => {});
  });

  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.metaKey || e.ctrlKey) {
      const effectiveMap = useHotkeysStore.getState().getEffectiveMap();
      for (const keys of Object.values(effectiveMap)) {
        if (keys && matchesHotkeyEvent(e, keys)) return false;
      }
    }
    if (e.key === "Enter" && e.shiftKey) {
      writeToPty("\x1b[13;2u");
      return false;
    }
    return true;
  });

  // Replay the accumulated scrollback. New sessions will return an empty
  // buffer.
  try {
    const buffered = await invoke<string>("pty_get_buffer", { sessionId });
    if (buffered) {
      const bytes = decodeBase64(buffered);
      if (bytes.length > 0) {
        terminal.clear();
        terminal.write(bytes);
      }
    }
  } catch {
    // Buffer may not exist yet for new sessions
  }

  const safeId = sanitizeEventId(sessionId);

  function flushWriteQueue() {
    entry.writeScheduled = false;
    if (entry.writeQueue.length === 0) return;
    const viewport = wrapper.querySelector(".xterm-viewport") as HTMLElement | null;
    let wasAtBottom = true;
    let savedScrollTop = 0;
    if (viewport) {
      savedScrollTop = viewport.scrollTop;
      wasAtBottom =
        viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5;
    }
    for (const chunk of entry.writeQueue) terminal.write(chunk);
    entry.writeQueue = [];
    if (!wasAtBottom && viewport) viewport.scrollTop = savedScrollTop;
  }

  entry.unlistenOutput = await listen<string>(`pty-output-${safeId}`, (event) => {
    entry.writeQueue.push(decodeBase64(event.payload));
    if (!entry.writeScheduled) {
      entry.writeScheduled = true;
      requestAnimationFrame(flushWriteQueue);
    }
  });

  entry.unlistenExit = await listen<number>(`pty-exit-${safeId}`, (event) => {
    entry.exitedRef.current = true;
    entry.exitCode = event.payload;
    entry.onExitHandler?.(event.payload);
  });

  entry.unlistenDragDrop = await getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop" || !entry.isFocusedRef.current) return;
    if (!wrapper.isConnected) return;
    const text = event.payload.paths
      .map((p) => (p.includes(" ") ? `'${p}'` : p))
      .join(" ");
    writeToPty(text);
  });

  return entry;
}

function disposeCachedTerminal(entry: CachedTerminal) {
  entry.linkDisposable?.dispose();
  entry.onDataDisposable?.dispose();
  entry.onResizeDisposable?.dispose();
  entry.unlistenOutput?.();
  entry.unlistenExit?.();
  entry.unlistenDragDrop?.();
  entry.webglAddon?.dispose();
  entry.terminal.dispose();
  entry.wrapper.remove();
  terminalCache.delete(entry.sessionId);
}

/**
 * Drop a cached terminal for a sessionId that will never be rendered again
 * (e.g. when the underlying PTY is killed via `pty_kill`). Callers in
 * tab-actions and elsewhere should call this alongside the kill so the xterm
 * instance releases its resources. Safe no-op if there is no cache entry.
 */
export function releaseCachedTerminal(sessionId: string) {
  const entry = terminalCache.get(sessionId);
  if (entry) disposeCachedTerminal(entry);
}

// Subscribe once at module load so theme/font changes propagate to every
// cached terminal, not just currently-mounted ones.
{
  let prevThemeId = useUIStore.getState().activeThemeId;
  let prevFontSize =
    useUIStore.getState().terminalFontSize ?? useUIStore.getState().fontSize;
  let prevFontFamily = useUIStore.getState().terminalFontFamily;
  useUIStore.subscribe((state) => {
    const themeChanged = state.activeThemeId !== prevThemeId;
    const effectiveSize =
      state.terminalFontSize ?? state.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
    const sizeChanged = effectiveSize !== prevFontSize;
    const familyChanged = state.terminalFontFamily !== prevFontFamily;
    if (!themeChanged && !sizeChanged && !familyChanged) return;
    prevThemeId = state.activeThemeId;
    prevFontSize = effectiveSize;
    prevFontFamily = state.terminalFontFamily;
    const theme = getTerminalTheme();
    const fontFamily = toXtermFontFamily(state.terminalFontFamily);
    for (const entry of terminalCache.values()) {
      if (themeChanged) {
        entry.terminal.options.theme = theme;
        entry.wrapper.style.background = theme.background ?? "";
      }
      if (sizeChanged) entry.terminal.options.fontSize = effectiveSize;
      if (familyChanged) entry.terminal.options.fontFamily = fontFamily;
      if (sizeChanged || familyChanged) {
        entry.webglAddon?.clearTextureAtlas();
        entry.fitAddon.fit();
      }
    }
  });
}

interface XtermTerminalProps {
  sessionId: string;
  baseDir?: string;
  isFocused?: boolean;
  onFocus?: () => void;
  onRestart?: () => void;
  scrollback?: number;
}

function XtermTerminalInner({
  sessionId,
  baseDir,
  isFocused = true,
  onFocus,
  onRestart,
  scrollback = 10000,
}: XtermTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<CachedTerminal | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [exited, setExited] = useState<number | null>(null);
  const termBg = useUIStore(
    (s) => resolveThemeById(s.activeThemeId, s.customThemes).terminal.background,
  );

  useAppHotkey(
    "CLEAR_TERMINAL",
    () => entryRef.current?.terminal.clear(),
    { enabled: isFocused },
  );

  useAppHotkey(
    "FIND_IN_TERMINAL",
    () => {
      setSearchVisible(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    },
    { enabled: isFocused },
  );

  // Attach / detach the cached wrapper to the host container.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let attachedEntry: CachedTerminal | null = null;

    const attach = async () => {
      let entry = terminalCache.get(sessionId);
      if (!entry) {
        entry = await createCachedTerminal(sessionId, scrollback);
        if (cancelled) {
          disposeCachedTerminal(entry);
          return;
        }
        terminalCache.set(sessionId, entry);
      }
      attachedEntry = entry;
      entryRef.current = entry;

      host.appendChild(entry.wrapper);
      // fit() only emits onResize (which drives pty_resize) when the
      // dimensions actually change. Same-size re-attaches don't SIGWINCH the
      // shell, so zsh doesn't redraw its prompt with PROMPT_EOL_MARK.
      entry.fitAddon.fit();
      entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));

      // Fit synchronously in the ResizeObserver callback (no RAF). The RAF
      // throttle added one frame of lag between CSS-driven container resize
      // and xterm cell reflow, which shows as a flash during drag — the
      // WebGL canvas scales with CSS before the cells re-wrap.
      resizeObserver = new ResizeObserver(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        entry?.fitAddon.fit();
      });
      resizeObserver.observe(host);

      entry.onExitHandler = (code) => setExited(code);
      if (entry.exitCode !== null) setExited(entry.exitCode);

      setLoading(false);
    };

    attach().catch((err) => {
      console.error("Terminal setup failed:", err);
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (attachedEntry) {
        attachedEntry.onExitHandler = null;
        // Park the wrapper outside the DOM. Keeping the instance alive is the
        // whole point of the cache.
        attachedEntry.wrapper.remove();
      }
      entryRef.current = null;
    };
  }, [sessionId, scrollback]);

  // Keep the cached baseDir in sync so the link provider can resolve paths
  // after the prop changes without tearing down the terminal.
  useEffect(() => {
    const entry = entryRef.current;
    if (entry) entry.baseDirRef.current = baseDir ?? null;
  }, [baseDir, sessionId]);

  // onFocus handler lives on the host container (not the cached wrapper) so
  // each mount gets its own callback.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onFocus) return;
    host.addEventListener("mousedown", onFocus);
    return () => host.removeEventListener("mousedown", onFocus);
  }, [onFocus]);

  // Hotkey capture on the host container. Stops bubbling so xterm's internal
  // listener can't also process a key that matches a registered app hotkey.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const effectiveMap = useHotkeysStore.getState().getEffectiveMap();
      for (const keys of Object.values(effectiveMap)) {
        if (keys && matchesHotkeyEvent(e, keys)) {
          e.stopPropagation();
          return;
        }
      }
    };
    host.addEventListener("keydown", handler, true);
    return () => host.removeEventListener("keydown", handler, true);
  }, []);

  // Focus/blur propagates to the cached terminal.
  useEffect(() => {
    const entry = entryRef.current;
    if (!entry) return;
    entry.isFocusedRef.current = isFocused;
    if (isFocused) {
      entry.terminal.write(SHOW_CURSOR);
      entry.terminal.focus();
    } else {
      entry.terminal.write(HIDE_CURSOR);
      entry.terminal.blur();
    }
  }, [isFocused, sessionId]);

  const closeSearch = () => {
    setSearchVisible(false);
    setSearchQuery("");
    entryRef.current?.searchAddon.clearDecorations();
    entryRef.current?.terminal.focus();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      closeSearch();
    } else if (e.key === "Enter") {
      if (e.shiftKey) {
        entryRef.current?.searchAddon.findPrevious(searchQuery);
      } else {
        entryRef.current?.searchAddon.findNext(searchQuery);
      }
    }
  };

  return (
    <div
      className="relative h-full w-full"
      style={{ background: termBg, padding: "4px" }}
    >
      {searchVisible && (
        <div className="absolute top-1 right-2 z-30 flex items-center gap-1 bg-background border border-border rounded px-2 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value)
                entryRef.current?.searchAddon.findNext(e.target.value);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search..."
            className="bg-transparent text-foreground text-md outline-none w-40 placeholder:text-muted-foreground"
          />
          <button
            onClick={() => entryRef.current?.searchAddon.findPrevious(searchQuery)}
            className="text-muted-foreground hover:text-foreground text-md px-1"
          >
            &#9650;
          </button>
          <button
            onClick={() => entryRef.current?.searchAddon.findNext(searchQuery)}
            className="text-muted-foreground hover:text-foreground text-md px-1"
          >
            &#9660;
          </button>
          <button
            onClick={closeSearch}
            className="text-muted-foreground hover:text-foreground text-md px-1"
          >
            &times;
          </button>
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground z-10">
          Loading terminal...
        </div>
      )}
      <div ref={hostRef} className="h-full w-full" />
      {exited !== null && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-20">
          <div className="text-center text-muted-foreground">
            <p className="text-sm">Process exited with code {exited}</p>
            {onRestart && (
              <button
                onClick={onRestart}
                className="mt-2 text-sm px-3 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/80"
              >
                Restart
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export const XtermTerminal = memo(XtermTerminalInner);
