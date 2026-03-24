import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Ghostty, Terminal, FitAddon } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";

interface GhosttyTerminalProps {
  sessionId: string;
}

function sanitizeEventId(id: string): string {
  return id.replace(/[^a-zA-Z0-9\-_]/g, "-");
}

// Cache the Ghostty WASM instance so it's only loaded once
let ghosttyPromise: Promise<Ghostty> | null = null;
function getGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) {
    ghosttyPromise = Ghostty.load(wasmUrl);
  }
  return ghosttyPromise;
}

export function GhosttyTerminal({ sessionId }: GhosttyTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [exited, setExited] = useState<number | null>(null);

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
        theme: {
          background: "#1a1a2e",
          foreground: "#e0e0e0",
          cursor: "#c0c0c0",
          selectionBackground: "rgba(255, 255, 255, 0.2)",
          black: "#1a1a2e",
          red: "#ff6b6b",
          green: "#51cf66",
          yellow: "#ffd43b",
          blue: "#748ffc",
          magenta: "#da77f2",
          cyan: "#66d9e8",
          white: "#e0e0e0",
          brightBlack: "#555577",
          brightRed: "#ff8787",
          brightGreen: "#69db7c",
          brightYellow: "#ffe066",
          brightBlue: "#91a7ff",
          brightMagenta: "#e599f7",
          brightCyan: "#99e9f2",
          brightWhite: "#ffffff",
        },
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
          const binaryStr = atob(buffered);
          if (binaryStr.length > 0) {
            // Clear terminal first to avoid mixing stale events
            terminal.clear();
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }
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
            String.fromCharCode(b),
          ).join(""),
        );
        invoke("pty_write", { sessionId, data: encoded });
      });

      const safeId = sanitizeEventId(sessionId);

      unlistenOutput = await listen<string>(
        `pty-output-${safeId}`,
        (event) => {
          if (cancelled || !terminal) return;
          const binaryStr = atob(event.payload);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          terminal.write(bytes);
        },
      );

      unlistenExit = await listen<number>(
        `pty-exit-${safeId}`,
        (event) => {
          if (cancelled) return;
          setExited(event.payload);
        },
      );

      if (cancelled) {
        unlistenOutput();
        unlistenExit();
        terminal.dispose();
        return;
      }

      terminal.focus();
    };

    setup().catch((err) => {
      console.error("Terminal setup failed:", err);
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      resizeDisposable?.dispose();
      dataDisposable?.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      if (terminal) {
        terminal.dispose();
        terminal = null;
      }
    };
  }, [sessionId]);

  return (
    <div className="relative h-full w-full bg-[#1a1a2e]">
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
