import { useEffect, useRef, useState, useCallback } from "react";
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

export function GhosttyTerminal({ sessionId }: GhosttyTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const initializedRef = useRef(false);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [loading, setLoading] = useState(true);
  const [exited, setExited] = useState<number | null>(null);

  const setupTerminal = useCallback(async () => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    console.log("Loading Ghostty WASM from:", wasmUrl);
    const ghostty = await Ghostty.load(wasmUrl);
    console.log("Ghostty WASM loaded successfully");

    const terminal = new Terminal({
      ghostty,
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 14,
      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
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

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setLoading(false);

    // Initial fit and resize PTY
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();
    if (dims) {
      await invoke("pty_resize", {
        sessionId,
        rows: dims.rows,
        cols: dims.cols,
      });
    }

    // Auto-resize on container size changes
    fitAddon.observeResize();

    // When terminal resizes, tell PTY backend
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      invoke("pty_resize", { sessionId, rows, cols });
    });

    // When user types, send to PTY (onData gives string)
    const dataDisposable = terminal.onData((data: string) => {
      const encoded = btoa(
        Array.from(new TextEncoder().encode(data), (b) =>
          String.fromCharCode(b)
        ).join("")
      );
      invoke("pty_write", { sessionId, data: encoded });
    });

    // Listen for PTY output events (Base64 encoded)
    const safeId = sanitizeEventId(sessionId);
    const unlistenOutput: UnlistenFn = await listen<string>(
      `pty-output-${safeId}`,
      (event) => {
        const binaryStr = atob(event.payload);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        terminal.write(bytes);
      }
    );

    // Listen for PTY exit events
    const unlistenExit: UnlistenFn = await listen<number>(
      `pty-exit-${safeId}`,
      (event) => {
        setExited(event.payload);
      }
    );

    terminal.focus();

    cleanupRef.current = () => {
      resizeDisposable.dispose();
      dataDisposable.dispose();
      unlistenOutput();
      unlistenExit();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    setupTerminal().catch((err) => {
      console.error("Terminal setup failed:", err);
      setLoading(false);
    });
    return () => {
      // Cleanup terminal but do NOT kill PTY (persists across tab switches)
      cleanupRef.current?.();
      cleanupRef.current = null;
      initializedRef.current = false;
    };
  }, [setupTerminal]);

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
