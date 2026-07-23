/** xterm sends Ctrl+C to its PTY as the ASCII ETX control character. */
export function isTerminalInterruptInput(data: string): boolean {
  return data === "\x03";
}
