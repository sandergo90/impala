import { useCallback, useEffect, useRef } from "react";
import { cn } from "../lib/utils";

interface ResizablePanelProps {
  children: React.ReactNode;
  width: number;
  onWidthChange: (width: number) => void;
  isResizing: boolean;
  onResizingChange: (isResizing: boolean) => void;
  minWidth: number;
  maxWidth: number;
  handleSide: "left" | "right";
  className?: string;
  onDoubleClickHandle?: () => void;
}

export function ResizablePanel({
  children,
  width,
  onWidthChange,
  isResizing,
  onResizingChange,
  minWidth,
  maxWidth,
  handleSide,
  className,
  onDoubleClickHandle,
}: ResizablePanelProps) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const pendingWidthRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const flushPendingWidth = useCallback(() => {
    const pending = pendingWidthRef.current;
    pendingWidthRef.current = null;
    if (pending === null) return;
    onWidthChange(pending);
  }, [onWidthChange]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      onResizingChange(true);
    },
    [width, onResizingChange],
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;
      const delta = e.clientX - startXRef.current;
      // Left-side handle: dragging left grows the panel.
      const adjustedDelta = handleSide === "left" ? -delta : delta;
      const raw = startWidthRef.current + adjustedDelta;
      pendingWidthRef.current = Math.max(minWidth, Math.min(maxWidth, raw));

      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        flushPendingWidth();
      });
    },
    [isResizing, minWidth, maxWidth, handleSide, flushPendingWidth],
  );

  const handleMouseUp = useCallback(() => {
    if (!isResizing) return;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    flushPendingWidth();
    onResizingChange(false);
  }, [isResizing, onResizingChange, flushPendingWidth]);

  useEffect(() => {
    if (!isResizing) return;
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingWidthRef.current = null;
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  return (
    <div
      className={cn(
        "relative h-full shrink-0 overflow-hidden border-border",
        handleSide === "right" ? "border-r" : "border-l",
        className,
      )}
      style={{ width }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onDoubleClick={onDoubleClickHandle}
        className={cn(
          "absolute top-0 w-5 h-full cursor-col-resize z-10",
          "after:absolute after:top-0 after:w-1 after:h-full after:transition-colors",
          "hover:after:bg-border focus:outline-none focus:after:bg-border",
          isResizing && "after:bg-border",
          handleSide === "left"
            ? "-left-2 after:right-2"
            : "-right-2 after:left-2",
        )}
      />
    </div>
  );
}
