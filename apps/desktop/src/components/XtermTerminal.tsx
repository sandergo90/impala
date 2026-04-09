import { useEffect, useRef, useState } from "react";
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

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

function getTerminalTheme() {
  const state = useUIStore.getState();
  return resolveThemeById(state.activeThemeId, state.customThemes).terminal;
}

interface XtermTerminalProps {
  sessionId: string;
  baseDir?: string;
  isFocused?: boolean;
  onFocus?: () => void;
  onRestart?: () => void;
  scrollback?: number;
}

function decodeBase64(encoded: string): Uint8Array {
  const binaryStr = atob(encoded);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

export function XtermTerminal({ sessionId, baseDir, isFocused = true, onFocus, onRestart, scrollback = 10000 }: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  const exitedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [exited, setExited] = useState<number | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const termBg = useUIStore(
    (s) => resolveThemeById(s.activeThemeId, s.customThemes).terminal.background
  );

  useAppHotkey(
    "CLEAR_TERMINAL",
    () => { terminalRef.current?.clear(); },
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let webglAddon: WebglAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeDisposable: { dispose(): void } | null = null;
    let dataDisposable: { dispose(): void } | null = null;
    let linkDisposable: { dispose(): void } | null = null;
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenDragDrop: UnlistenFn | null = null;

    function writeToPty(text: string) {
      if (exitedRef.current) return;
      const encoded = encodePtyInput(text);
      invoke("pty_write", { sessionId, data: encoded }).catch(() => {});
    }

    getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type !== "drop" || !isFocusedRef.current) return;
      if (!container.checkVisibility()) return;
      const text = event.payload.paths
        .map((p) => (p.includes(" ") ? `'${p}'` : p))
        .join(" ");
      writeToPty(text);
    }).then((fn) => {
      if (cancelled) fn();  // immediately unlisten if effect already cleaned up
      else unlistenDragDrop = fn;
    });

    const interceptKeys = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      // Dynamically check if the event matches any registered hotkey.
      // This ensures rebinds in settings are respected by the terminal.
      const effectiveMap = useHotkeysStore.getState().getEffectiveMap();
      for (const keys of Object.values(effectiveMap)) {
        if (keys && matchesHotkeyEvent(e, keys)) {
          e.stopPropagation();
          return;
        }
      }
    };
    container.addEventListener("keydown", interceptKeys, true);

    if (onFocus) {
      container.addEventListener("mousedown", onFocus);
    }

    const setup = async () => {
      if (cancelled) return;

      terminal = new Terminal({
        scrollback,
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: useUIStore.getState().fontSize,
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
        theme: getTerminalTheme(),
        allowProposedApi: true,
      });

      terminalRef.current = terminal;

      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      const searchAddon = new SearchAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(searchAddon);
      searchAddonRef.current = searchAddon;
      terminal.open(container);

      const baseDirRef = { current: baseDir ?? null };
      linkDisposable = terminal.registerLinkProvider(
        createFileLinkProvider(terminal, () => baseDirRef.current),
      );

      // WebGL must be loaded after open()
      try {
        webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon?.dispose();
          webglAddon = null;
        });
        terminal.loadAddon(webglAddon);
      } catch {
        webglAddon = null;
      }

      if (cancelled) {
        terminal.dispose();
        return;
      }

      setLoading(false);

      fitAddon.fit();

      try {
        const buffered = await invoke<string>("pty_get_buffer", { sessionId });
        if (buffered && !cancelled) {
          const bytes = decodeBase64(buffered);
          if (bytes.length > 0) {
            terminal.clear();
            terminal.write(bytes);
          }
        }
      } catch {
        // Buffer may not exist yet for new sessions
      }

      if (cancelled) {
        terminal?.dispose();
        return;
      }

      // Resize PTY to match terminal — sends SIGWINCH for TUI app redraw
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        await invoke("pty_resize", {
          sessionId,
          rows: dims.rows,
          cols: dims.cols,
        });
      }

      let rafPending = false;
      resizeObserver = new ResizeObserver(() => {
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            fitAddon?.fit();
          });
        }
      });
      resizeObserver.observe(container);

      resizeDisposable = terminal.onResize(({ cols, rows }) => {
        if (exitedRef.current) return;
        invoke("pty_resize", { sessionId, rows, cols }).catch(() => {});
      });

      terminal.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
          // Send Kitty keyboard protocol sequence for Shift+Enter
          writeToPty("\x1b[13;2u");
          return false;
        }
        return true;
      });

      dataDisposable = terminal.onData((data: string) => {
        writeToPty(data);
      });

      const safeId = sanitizeEventId(sessionId);

      // .xterm-viewport is xterm's internal scrollable element — fragile across versions
      const viewport = container.querySelector(".xterm-viewport") as HTMLElement | null;

      let writeQueue: Uint8Array[] = [];
      let writeScheduled = false;

      function flushWriteQueue() {
        writeScheduled = false;
        if (!terminal || cancelled) return;

        let wasAtBottom = true;
        let savedScrollTop = 0;
        if (viewport) {
          savedScrollTop = viewport.scrollTop;
          wasAtBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5;
        }

        for (const chunk of writeQueue) {
          terminal.write(chunk);
        }
        writeQueue = [];

        if (!wasAtBottom && viewport) {
          viewport.scrollTop = savedScrollTop;
        }
      }

      unlistenOutput = await listen<string>(`pty-output-${safeId}`, (event) => {
        if (cancelled || !terminal) return;
        writeQueue.push(decodeBase64(event.payload));
        if (!writeScheduled) {
          writeScheduled = true;
          requestAnimationFrame(flushWriteQueue);
        }
      });

      unlistenExit = await listen<number>(`pty-exit-${safeId}`, (event) => {
        if (cancelled) return;
        exitedRef.current = true;
        setExited(event.payload);
      });

      if (cancelled) {
        unlistenOutput();
        unlistenExit();
        terminal.dispose();
        return;
      }

      if (isFocusedRef.current) {
        terminal.focus();
      } else {
        terminal.write(HIDE_CURSOR);
        terminal.blur();
      }
    };

    setup().catch((err) => {
      console.error("Terminal setup failed:", err);
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      container.removeEventListener("keydown", interceptKeys, true);
      if (onFocus && container) {
        container.removeEventListener("mousedown", onFocus);
      }
      unlistenDragDrop?.();
      resizeObserver?.disconnect();
      resizeDisposable?.dispose();
      dataDisposable?.dispose();
      linkDisposable?.dispose();
      webglAddon?.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      if (terminal) {
        terminal.dispose();
        terminal = null;
      }
      searchAddonRef.current = null;
      fitAddonRef.current = null;
      terminalRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!terminalRef.current) return;
    if (isFocused) {
      terminalRef.current.write(SHOW_CURSOR);
      terminalRef.current.focus();
    } else {
      terminalRef.current.write(HIDE_CURSOR);
      terminalRef.current.blur();
    }
  }, [isFocused]);

  useEffect(() => {
    let prevThemeId = useUIStore.getState().activeThemeId;
    let prevFontSize = useUIStore.getState().fontSize;
    const unsubscribe = useUIStore.subscribe((state) => {
      if (state.activeThemeId !== prevThemeId) {
        prevThemeId = state.activeThemeId;
        if (terminalRef.current) {
          terminalRef.current.options.theme = getTerminalTheme();
        }
      }
      if (state.fontSize !== prevFontSize) {
        prevFontSize = state.fontSize;
        if (terminalRef.current) {
          terminalRef.current.options.fontSize = state.fontSize;
          fitAddonRef.current?.fit();
        }
      }
    });
    return unsubscribe;
  }, []);

  const closeSearch = () => {
    setSearchVisible(false);
    setSearchQuery("");
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      closeSearch();
    } else if (e.key === "Enter") {
      if (e.shiftKey) {
        searchAddonRef.current?.findPrevious(searchQuery);
      } else {
        searchAddonRef.current?.findNext(searchQuery);
      }
    }
  };

  return (
    <div className="relative h-full w-full" style={{ background: termBg }}>
      {searchVisible && (
        <div className="absolute top-1 right-2 z-30 flex items-center gap-1 bg-background border border-border rounded px-2 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) searchAddonRef.current?.findNext(e.target.value);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search..."
            className="bg-transparent text-foreground text-md outline-none w-40 placeholder:text-muted-foreground"
          />
          <button onClick={() => searchAddonRef.current?.findPrevious(searchQuery)} className="text-muted-foreground hover:text-foreground text-md px-1">&#9650;</button>
          <button onClick={() => searchAddonRef.current?.findNext(searchQuery)} className="text-muted-foreground hover:text-foreground text-md px-1">&#9660;</button>
          <button onClick={closeSearch} className="text-muted-foreground hover:text-foreground text-md px-1">&times;</button>
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground z-10">
          Loading terminal...
        </div>
      )}
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ padding: "4px" }}
      />
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
