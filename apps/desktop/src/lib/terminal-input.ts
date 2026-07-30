/** xterm sends Ctrl+C to its PTY as the ASCII ETX control character. */
export function isTerminalInterruptInput(data: string): boolean {
  return data === "\x03";
}

// SGR mouse report (ESC [ < btn ; col ; row M/m) where a field is "NaN".
// xterm.js emits these when a mouse event lands while the renderer has no
// cell dimensions (zero-size pane, or the window between reattach and the
// first fit()). The TUI's parser aborts on the "N" and the residue shows
// up as literal input like "aN;NaNM".
const BROKEN_MOUSE_REPORT =
  /\x1b\[<(?=(?:\d+|NaN);(?:\d+|NaN);(?:\d+|NaN)[Mm])[^Mm]*NaN[^Mm]*[Mm]/g;

/** Drop mouse reports with NaN coordinates; pass everything else through. */
export function stripBrokenMouseReports(data: string): string {
  if (!data.includes("NaN")) return data;
  return data.replace(BROKEN_MOUSE_REPORT, "");
}
