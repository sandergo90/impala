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

function StatusDot({ status }: { status: "running" | "succeeded" | "failed" }) {
  const color =
    status === "running"
      ? "bg-green-500"
      : status === "failed"
        ? "bg-red-500"
        : "bg-muted-foreground";
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

export function FloatingTerminal() {
  const wtPath = useUIStore((s) => s.selectedWorktree?.path);
  const ft = useUIStore((s) =>
    wtPath ? s.floatingTerminals[wtPath] : undefined
  );
  const setFloatingTerminal = useUIStore((s) => s.setFloatingTerminal);
  const size = useUIStore((s) => s.floatingTerminalSize);
  const setSize = useUIStore((s) => s.setFloatingTerminalSize);

  const mode = ft?.mode ?? "hidden";
  const sessionId = ft?.sessionId ?? null;
  const label = ft?.label ?? "";
  const status = ft?.status ?? "running";

  const dragRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    edge: string;
  } | null>(null);

  // Listen for process exit
  useEffect(() => {
    if (!sessionId || !wtPath) return;

    const safeId = sanitizeEventId(sessionId);
    let cancelled = false;

    const unlistenPromise = listen<number>(`pty-exit-${safeId}`, (event) => {
      if (cancelled) return;
      const exitCode = event.payload;
      const current = useUIStore.getState().getFloatingTerminal(wtPath);
      const failed = exitCode !== 0;

      if (failed) {
        const failLabel =
          current.type === "setup" ? "Setup failed" : "Run failed";
        setFloatingTerminal(wtPath, { label: failLabel, status: "failed" });
      } else if (current.type === "setup") {
        setFloatingTerminal(wtPath, {
          label: "Setup complete",
          status: "succeeded",
          mode: "pill",
        });
      } else if (current.type === "run") {
        setFloatingTerminal(wtPath, {
          label: "Run stopped",
          status: "succeeded",
          mode: "pill",
        });
      } else {
        setFloatingTerminal(wtPath, { status: "succeeded", mode: "pill" });
      }
    });

    return () => {
      cancelled = true;
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [sessionId, wtPath, setFloatingTerminal]);

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

        if (edge.includes("left")) {
          newW = Math.min(
            MAX_WIDTH,
            Math.max(MIN_WIDTH, startW + (startX - ev.clientX))
          );
        }
        if (edge.includes("top")) {
          newH = Math.min(
            MAX_HEIGHT,
            Math.max(MIN_HEIGHT, startH + (startY - ev.clientY))
          );
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
    if (!wtPath) return;
    if (sessionId) {
      invoke("pty_kill", { sessionId }).catch(() => {});
    }
    setFloatingTerminal(wtPath, {
      mode: "hidden",
      sessionId: null,
      label: "",
      type: null,
      status: "running",
    });
  };

  if (mode === "hidden" || !sessionId) return null;

  if (mode === "pill") {
    return (
      <div
        className="fixed bottom-4 right-4 z-50 bg-card border border-border/80 rounded-full px-3 py-1.5 cursor-pointer flex items-center gap-2 ring-1 ring-black/20"
        style={{
          boxShadow:
            "0 4px 20px rgba(0,0,0,0.35), 0 1px 6px rgba(0,0,0,0.25)",
        }}
      >
        <button
          onClick={() => wtPath && setFloatingTerminal(wtPath, { mode: "expanded" })}
          className="flex items-center gap-2"
        >
          <StatusDot status={status} />
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
      className="fixed bottom-4 right-4 z-50 bg-card border border-border/80 rounded-lg overflow-hidden flex flex-col ring-1 ring-black/20"
      style={{
        width: size.width,
        height: size.height,
        boxShadow:
          "0 8px 40px rgba(0,0,0,0.45), 0 2px 12px rgba(0,0,0,0.3)",
      }}
    >
      {/* Resize handles */}
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
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot status={status} />
          <span className="text-xs text-foreground truncate">{label}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => wtPath && setFloatingTerminal(wtPath, { mode: "pill" })}
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
        <XtermTerminal sessionId={sessionId} isFocused scrollback={50000} />
      </div>
    </div>
  );
}
