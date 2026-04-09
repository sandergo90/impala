import { invoke } from "@tauri-apps/api/core";
import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";
import { parseFileLinks } from "./file-link-parser";
import { openFileInEditor } from "./open-file-in-editor";

const existsCache = new Map<string, { exists: boolean; absPath: string; ts: number }>();
const CACHE_TTL_MS = 10_000;
const MAX_CACHE_SIZE = 500;

async function resolveAndCache(
  baseDir: string,
  candidate: string,
): Promise<{ absPath: string; exists: boolean }> {
  const key = `${baseDir}:${candidate}`;
  const cached = existsCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { absPath: cached.absPath, exists: cached.exists };
  }
  const [absPath, exists] = await invoke<[string, boolean]>("resolve_file_path", {
    baseDir,
    candidate,
  });
  existsCache.set(key, { absPath, exists, ts: Date.now() });
  if (existsCache.size > MAX_CACHE_SIZE) {
    // Evict oldest entries (first inserted)
    const entriesToDelete = existsCache.size - MAX_CACHE_SIZE;
    let count = 0;
    for (const key of existsCache.keys()) {
      if (count >= entriesToDelete) break;
      existsCache.delete(key);
      count++;
    }
  }
  return { absPath, exists };
}

export function createFileLinkProvider(
  terminal: Terminal,
  getBaseDir: () => string | null,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const baseDir = getBaseDir();
      if (!baseDir) {
        callback(undefined);
        return;
      }

      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString(true);
      const fileLinks = parseFileLinks(text);

      if (fileLinks.length === 0) {
        callback(undefined);
        return;
      }

      Promise.all(
        fileLinks.map(async (fl) => {
          const { absPath, exists } = await resolveAndCache(baseDir, fl.path);
          if (!exists) return null;
          const link: ILink = {
            range: {
              start: { x: fl.startIndex + 1, y: bufferLineNumber },
              end: { x: fl.endIndex + 1, y: bufferLineNumber },
            },
            text: text.slice(fl.startIndex, fl.endIndex),
            activate(_event: MouseEvent, _text: string) {
              openFileInEditor(absPath, fl.line, fl.col);
            },
          };
          return link;
        }),
      ).then((results) => {
        const links = results.filter((r): r is ILink => r !== null);
        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}
