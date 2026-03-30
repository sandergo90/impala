import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useUIStore } from "../store";
import { resolveThemeById } from "../themes/apply";

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

function getTerminalTheme() {
  const state = useUIStore.getState();
  return resolveThemeById(state.activeThemeId, state.customThemes).terminal;
}

interface XtermTerminalProps {
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

export function XtermTerminal({ sessionId, isFocused = true, onFocus, onRestart }: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  const exitedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [exited, setExited] = useState<number | null>(null);
  const termBg = useUIStore(
    (s) => resolveThemeById(s.activeThemeId, s.customThemes).terminal.background
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
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenDragDrop: UnlistenFn | null = null;

    function writeToPty(text: string) {
      if (exitedRef.current) return;
      const encoded = btoa(
        Array.from(new TextEncoder().encode(text), (b) =>
          String.fromCharCode(b)
        ).join("")
      );
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

    if (onFocus) {
      container.addEventListener("mousedown", onFocus);
    }

    const setup = async () => {
      if (cancelled) return;

      terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: 14,
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
        theme: getTerminalTheme(),
        allowProposedApi: true,
      });

      terminalRef.current = terminal;

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);

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
        terminal.dispose();
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

      dataDisposable = terminal.onData((data: string) => {
        writeToPty(data);
      });

      const safeId = sanitizeEventId(sessionId);

      // .xterm-viewport is xterm's internal scrollable element — fragile across versions
      const viewport = container.querySelector(".xterm-viewport") as HTMLElement | null;

      unlistenOutput = await listen<string>(`pty-output-${safeId}`, (event) => {
        if (cancelled || !terminal) return;
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
      webglAddon?.dispose();
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
      terminalRef.current.write(SHOW_CURSOR);
      terminalRef.current.focus();
    } else {
      terminalRef.current.write(HIDE_CURSOR);
      terminalRef.current.blur();
    }
  }, [isFocused]);

  useEffect(() => {
    let prevThemeId = useUIStore.getState().activeThemeId;
    const unsubscribe = useUIStore.subscribe((state) => {
      if (state.activeThemeId !== prevThemeId) {
        prevThemeId = state.activeThemeId;
        if (terminalRef.current) {
          terminalRef.current.options.theme = getTerminalTheme();
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
