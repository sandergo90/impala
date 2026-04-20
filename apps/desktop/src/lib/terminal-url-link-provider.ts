import { open as openUrl } from "@tauri-apps/plugin-shell";
import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;

export function createUrlLinkProvider(terminal: Terminal): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString(true);
      URL_RE.lastIndex = 0;
      const links: ILink[] = [];
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(text)) !== null) {
        const url = m[0];
        links.push({
          range: {
            start: { x: m.index + 1, y: bufferLineNumber },
            end: { x: m.index + url.length, y: bufferLineNumber },
          },
          text: url,
          activate(_event: MouseEvent, target: string) {
            openUrl(target).catch(() => {});
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
