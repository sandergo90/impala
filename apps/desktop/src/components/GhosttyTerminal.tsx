import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Ghostty, Terminal, FitAddon } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";
import { useUIStore } from "../store";
import { resolveThemeById } from "../themes/apply";

function getTerminalTheme() {
  const state = useUIStore.getState();
  return resolveThemeById(state.activeThemeId, state.customThemes).terminal;
}

interface GhosttyTerminalProps {
  sessionId: string;
  isFocused?: boolean;
  onFocus?: () => void;
  onRestart?: () => void;
}

function sanitizeEventId(id: string): string {
  return id.replace(/[^a-zA-Z0-9\-_]/g, "-");
}

function decodeBase64(encoded: string): Uint8Array {
  const binaryStr = atob(encoded);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

// Cache the Ghostty WASM instance so it's only loaded once
let ghosttyPromise: Promise<Ghostty> | null = null;
function getGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) {
    ghosttyPromise = Ghostty.load(wasmUrl);
  }
  return ghosttyPromise;
}

export function GhosttyTerminal({ sessionId, isFocused = true, onFocus, onRestart }: GhosttyTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  const exitedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [exited, setExited] = useState<number | null>(null);
  const [termBg, setTermBg] = useState(() => getTerminalTheme().background);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let resizeDisposable: { dispose(): void } | null = null;
    let dataDisposable: { dispose(): void } | null = null;
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;

    // Intercept keybindings in capture phase before Ghostty consumes them
    const interceptKeys = (e: KeyboardEvent) => {
      if (e.metaKey) {
        if (e.key === "d" || e.key === "D" || e.key === "[" || e.key === "]" || e.key === "w" || e.key === ",") {
          e.stopPropagation();
        }
        if (e.key === "k") {
          e.preventDefault();
          e.stopPropagation();
          // Ctrl+L clears screen in shells; SIGWINCH redraws TUI apps
          const ctrlL = btoa(String.fromCharCode(0x0c));
          invoke("pty_write", { sessionId, data: ctrlL }).catch(() => {});
          const dims = fitAddon?.proposeDimensions();
          if (dims) {
            invoke("pty_resize", { sessionId, rows: dims.rows, cols: dims.cols }).catch(() => {});
          }
        }
      }
    };
    container.addEventListener("keydown", interceptKeys, true);

    const setup = async () => {
      const ghostty = await getGhostty();
      if (cancelled) return;

      terminal = new Terminal({
        ghostty,
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: 14,
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
        theme: getTerminalTheme(),
      });

      terminalRef.current = terminal;

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);

      if (cancelled) {
        terminal.dispose();
        return;
      }

      setLoading(false);

      // Fit terminal to container FIRST (before buffer replay)
      fitAddon.fit();

      // Replay buffered output (scrollback restoration for existing sessions)
      try {
        const buffered = await invoke<string>("pty_get_buffer", { sessionId });
        if (buffered && !cancelled) {
          const bytes = decodeBase64(buffered);
          if (bytes.length > 0) {
            // Clear terminal first to avoid mixing stale events
            terminal.clear();
            terminal.write(bytes);
          }
        }
      } catch {
        // Buffer may not exist yet for new sessions
      }

      if (cancelled) {
        terminal.dispose();
        return;
      }

      // Resize PTY to match terminal — this sends SIGWINCH which makes
      // TUI apps (like Claude Code) redraw cleanly
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        await invoke("pty_resize", {
          sessionId,
          rows: dims.rows,
          cols: dims.cols,
        });
      }

      fitAddon.observeResize();

      resizeDisposable = terminal.onResize(({ cols, rows }) => {
        if (exitedRef.current) return;
        invoke("pty_resize", { sessionId, rows, cols }).catch(() => {});
      });

      dataDisposable = terminal.onData((data: string) => {
        if (exitedRef.current) return;
        const encoded = btoa(
          Array.from(new TextEncoder().encode(data), (b) =>
            String.fromCharCode(b)
          ).join("")
        );
        invoke("pty_write", { sessionId, data: encoded }).catch(() => {});
      });

      const safeId = sanitizeEventId(sessionId);

      // Find the scrollable viewport element for scroll-lock behavior
      const viewport = container.querySelector('[class*="viewport"]') as HTMLElement
        ?? container.querySelector('[style*="overflow"]') as HTMLElement
        ?? null;

      unlistenOutput = await listen<string>(`pty-output-${safeId}`, (event) => {
        if (cancelled || !terminal) return;
        // Preserve scroll position if user has scrolled up
        let wasAtBottom = true;
        let savedScrollTop = 0;
        if (viewport) {
          savedScrollTop = viewport.scrollTop;
          wasAtBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5;
        }
        terminal.write(decodeBase64(event.payload));
        if (!wasAtBottom && viewport) {
          viewport.scrollTop = savedScrollTop;
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
        terminal.write("\x1b[?25l"); // hide cursor for unfocused pane
        terminal.blur();
      }

      // Notify parent when terminal receives focus
      if (onFocus) {
        container.addEventListener("mousedown", onFocus);
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
      resizeDisposable?.dispose();
      dataDisposable?.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      if (terminal) {
        terminal.dispose();
        terminal = null;
      }
      terminalRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!terminalRef.current) return;
    if (isFocused) {
      terminalRef.current.write("\x1b[?25h"); // DECTCEM: show cursor
      terminalRef.current.focus();
    } else {
      terminalRef.current.write("\x1b[?25l"); // DECTCEM: hide cursor
      terminalRef.current.blur();
    }
  }, [isFocused]);

  useEffect(() => {
    let prevThemeId = useUIStore.getState().activeThemeId;
    const unsubscribe = useUIStore.subscribe((state) => {
      if (state.activeThemeId !== prevThemeId) {
        prevThemeId = state.activeThemeId;
        const termTheme = getTerminalTheme();
        setTermBg(termTheme.background);
        if (terminalRef.current?.renderer) {
          terminalRef.current.renderer.setTheme(termTheme);
        }
      }
    });
    return unsubscribe;
  }, []);

  return (
    <div className="relative h-full w-full" style={{ background: termBg }}>
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
