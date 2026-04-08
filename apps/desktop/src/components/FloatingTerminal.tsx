import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useUIStore } from "../store";
import { XtermTerminal } from "./XtermTerminal";

function sanitizeEventId(id: string): string {
  return id.replace(/[^a-zA-Z0-9\-_]/g, "-");
}

const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 700;

export function FloatingTerminal() {
  const { mode, sessionId, label, type } = useUIStore((s) => s.floatingTerminal);
  const setFloatingTerminal = useUIStore((s) => s.setFloatingTerminal);
  const size = useUIStore((s) => s.floatingTerminalSize);
  const setSize = useUIStore((s) => s.setFloatingTerminalSize);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    edge: string;
  } | null>(null);

  // Listen for process exit
  useEffect(() => {
    if (!sessionId) return;

    const safeId = sanitizeEventId(sessionId);
    let cancelled = false;

    const unlistenPromise = listen<number>(`pty-exit-${safeId}`, () => {
      if (cancelled) return;
      const current = useUIStore.getState().floatingTerminal;
      if (current.type === "setup") {
        setFloatingTerminal({ label: "Setup complete", mode: "pill" });
      } else if (current.type === "run") {
        setFloatingTerminal({ label: "Run stopped", mode: "pill" });
      } else {
        setFloatingTerminal({ mode: "pill" });
      }
    });

    return () => {
      cancelled = true;
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [sessionId, setFloatingTerminal]);

  const onResizeStart = useCallback(
    (e: React.MouseEvent, edge: string) => {
      e.preventDefault();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: size.width,
        startH: size.height,
        edge,
      };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const { startX, startY, startW, startH, edge } = dragRef.current;
        let newW = startW;
        let newH = startH;

        // Panel is anchored bottom-right, so dragging left/up increases size
        if (edge.includes("left")) {
          newW = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (startX - ev.clientX)));
        }
        if (edge.includes("top")) {
          newH = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)));
        }

        setSize({ width: newW, height: newH });
      };

      const onMouseUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [size, setSize]
  );

  const dismiss = () => {
    if (sessionId) {
      invoke("pty_kill", { sessionId }).catch(() => {});
    }
    setFloatingTerminal({
      mode: "hidden",
      sessionId: null,
      label: "",
      type: null,
      worktreePath: null,
    });
  };

  if (mode === "hidden" || !sessionId) return null;

  if (mode === "pill") {
    return (
      <div className="fixed bottom-4 right-4 z-50 bg-card border border-border rounded-full px-3 py-1.5 shadow-lg cursor-pointer flex items-center gap-2">
        <button
          onClick={() => setFloatingTerminal({ mode: "expanded" })}
          className="flex items-center gap-2"
        >
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              type === "run" ? "bg-green-500" : "bg-muted-foreground"
            }`}
          />
          <span className="text-xs text-foreground">{label}</span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
          className="text-muted-foreground hover:text-foreground text-xs ml-1"
        >
          &times;
        </button>
      </div>
    );
  }

  // mode === 'expanded'
  const titleBarHeight = 32;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 bg-card border border-border rounded-lg overflow-hidden shadow-xl flex flex-col"
      style={{ width: size.width, height: size.height }}
    >
      {/* Resize handles — top edge, left edge, top-left corner */}
      <div
        className="absolute top-0 left-3 right-0 h-1 cursor-n-resize z-10"
        onMouseDown={(e) => onResizeStart(e, "top")}
      />
      <div
        className="absolute top-3 left-0 bottom-0 w-1 cursor-w-resize z-10"
        onMouseDown={(e) => onResizeStart(e, "left")}
      />
      <div
        className="absolute top-0 left-0 w-3 h-3 cursor-nw-resize z-10"
        onMouseDown={(e) => onResizeStart(e, "top-left")}
      />

      <div className="h-8 flex items-center justify-between px-3 border-b border-border/50 bg-background shrink-0">
        <span className="text-xs text-foreground truncate">{label}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setFloatingTerminal({ mode: "pill" })}
            className="text-muted-foreground hover:text-foreground text-xs px-1"
            title="Minimize"
          >
            &#8211;
          </button>
          <button
            onClick={dismiss}
            className="text-muted-foreground hover:text-foreground text-xs px-1"
            title="Close"
          >
            &times;
          </button>
        </div>
      </div>
      <div style={{ height: size.height - titleBarHeight }}>
        <XtermTerminal sessionId={sessionId} isFocused />
      </div>
    </div>
  );
}
