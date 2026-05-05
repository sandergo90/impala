import type { IDecoration, Terminal } from "@xterm/xterm";

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;

interface TrackedEntry {
  decoration: IDecoration;
  element: HTMLElement | null;
  col: number;
  len: number;
  text: string;
}

export interface UrlUnderlineManager {
  scheduleScan(): void;
  refreshColor(): void;
  dispose(): void;
}

/**
 * Paints persistent underlines beneath every detected URL in the visible
 * viewport so users can see at a glance that a URL is clickable. Without
 * this, xterm only underlines link-provider links on hover.
 *
 * Implementation: registers an xterm decoration per URL, anchored to a
 * marker so scrolling moves the underline with the line. Scans run on
 * RAF after writes/scrolls/resizes and reconcile against existing
 * decorations — TUIs (claude/codex) constantly redraw the alt-screen,
 * so URLs at a given line can move; reconciliation disposes stale
 * decorations and registers new ones.
 */
export function createUrlUnderlineManager(
  terminal: Terminal,
  getColor: () => string,
): UrlUnderlineManager {
  const tracked: TrackedEntry[] = [];
  let scanScheduled = false;
  let disposed = false;

  function scheduleScan() {
    if (scanScheduled || disposed) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      if (!disposed) scan();
    });
  }

  function clearAll() {
    for (const entry of [...tracked]) entry.decoration.dispose();
    tracked.length = 0;
  }

  function scan() {
    const buf = terminal.buffer.active;
    const viewportStart = buf.viewportY;
    const viewportEnd = Math.min(viewportStart + terminal.rows, buf.length);

    type Detected = { y: number; col: number; len: number; text: string };
    const detected: Detected[] = [];
    for (let y = viewportStart; y < viewportEnd; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (!text) continue;
      URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(text)) !== null) {
        detected.push({ y, col: m.index, len: m[0].length, text: m[0] });
      }
    }

    const matchedEntries = new Set<TrackedEntry>();
    const matchedDetected = new Set<Detected>();
    for (const entry of tracked) {
      const line = entry.decoration.marker.line;
      if (line < viewportStart || line >= viewportEnd) continue;
      const hit = detected.find(
        (d) =>
          !matchedDetected.has(d) &&
          d.y === line &&
          d.col === entry.col &&
          d.len === entry.len &&
          d.text === entry.text,
      );
      if (hit) {
        matchedEntries.add(entry);
        matchedDetected.add(hit);
      }
    }

    for (const entry of [...tracked]) {
      const line = entry.decoration.marker.line;
      if (line < viewportStart || line >= viewportEnd) continue;
      if (!matchedEntries.has(entry)) entry.decoration.dispose();
    }

    const cursorAbs = buf.viewportY + buf.cursorY;
    for (const d of detected) {
      if (matchedDetected.has(d)) continue;
      const cursorYOffset = d.y - cursorAbs;
      const marker = terminal.registerMarker(cursorYOffset);
      if (!marker) continue;
      const decoration = terminal.registerDecoration({
        marker,
        x: d.col,
        width: d.len,
        height: 1,
        layer: "bottom",
      });
      if (!decoration) {
        marker.dispose();
        continue;
      }
      const entry: TrackedEntry = {
        decoration,
        element: null,
        col: d.col,
        len: d.len,
        text: d.text,
      };
      tracked.push(entry);
      decoration.onRender((el) => {
        entry.element = el;
        el.style.borderBottom = `1px solid ${getColor()}`;
        el.style.pointerEvents = "none";
        el.style.boxSizing = "border-box";
      });
      decoration.onDispose(() => {
        const idx = tracked.indexOf(entry);
        if (idx >= 0) tracked.splice(idx, 1);
      });
    }
  }

  // Buffer switch (e.g. claude entering alt-screen) — drop everything; the
  // marker/line indices belong to the previous buffer.
  const onBufferChangeDispose = terminal.buffer.onBufferChange(() => {
    clearAll();
    scheduleScan();
  });
  const onScrollDispose = terminal.onScroll(() => scheduleScan());
  const onResizeDispose = terminal.onResize(() => scheduleScan());

  return {
    scheduleScan,
    refreshColor() {
      const color = getColor();
      for (const entry of tracked) {
        if (entry.element) {
          entry.element.style.borderBottomColor = color;
        }
      }
    },
    dispose() {
      disposed = true;
      onBufferChangeDispose.dispose();
      onScrollDispose.dispose();
      onResizeDispose.dispose();
      clearAll();
    },
  };
}
