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
  onFocus?: () => void;
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

export function GhosttyTerminal({ sessionId, onFocus }: GhosttyTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
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

      // Let split keybindings pass through to the app instead of being consumed by the terminal
      terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.metaKey && e.type === "keydown") {
          // Cmd+D, Cmd+Shift+D, Cmd+[, Cmd+], Cmd+W, Cmd+,
          if (e.key === "d" || e.key === "D" || e.key === "[" || e.key === "]" || e.key === "w" || e.key === ",") {
            return false; // don't let terminal handle it
          }
        }
        return true;
      });

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
        invoke("pty_resize", { sessionId, rows, cols });
      });

      dataDisposable = terminal.onData((data: string) => {
        const encoded = btoa(
          Array.from(new TextEncoder().encode(data), (b) =>
            String.fromCharCode(b)
          ).join("")
        );
        invoke("pty_write", { sessionId, data: encoded });
      });

      const safeId = sanitizeEventId(sessionId);

      unlistenOutput = await listen<string>(`pty-output-${safeId}`, (event) => {
        if (cancelled || !terminal) return;
        terminal.write(decodeBase64(event.payload));
      });

      unlistenExit = await listen<number>(`pty-exit-${safeId}`, (event) => {
        if (cancelled) return;
        setExited(event.payload);
      });

      if (cancelled) {
        unlistenOutput();
        unlistenExit();
        terminal.dispose();
        return;
      }

      terminal.focus();

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
          </div>
        </div>
      )}
    </div>
  );
}
