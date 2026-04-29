# Task 2: Image / binary / large-file handling in FileViewer

**Plan:** File Explorer — Phase 2: Live + Decorated
**Goal:** When the user clicks a non-text file, render something sensible instead of dumping bytes through the source-code highlighter. Images get inline preview. Binaries get a refusal card with size + open-in-editor. Text files larger than 1MB get a "load anyway" prompt before reading. SVGs render as images by default with a "view source" toggle.
**Depends on:** none

**Files:**
- Create: `apps/desktop/src/lib/file-kind.ts`
- Modify: `apps/desktop/src/components/FileViewer.tsx`

**Background context:**
- `@tauri-apps/api/core` exports `convertFileSrc(absPath)` which produces a webview-safe URL (e.g. `tauri://localhost/<encoded-path>`) usable in `<img src>`. No need to base64 the bytes through IPC.
- `@tauri-apps/plugin-fs` is a project dep. It exposes `stat(path)` returning `{ size, mtime, ... }`. Use `stat` for the size guard; cheaper than reading.
- Phase 1's `FileViewer` reads via `readTextFile` unconditionally and renders whatever comes back. We replace that with a kind-aware dispatch.
- The existing project lacks any `mime-db`-style dep. Stay extension-based — it's right >99% of the time and ships zero new deps.
- Tauri 2 webview asset protocol must be enabled in `tauri.conf.json` for `convertFileSrc` URLs to load. Verify (`grep -n "assetProtocol" backend/tauri/tauri.conf.json`); if not enabled, the implementer MUST enable `app.security.assetProtocol.enable = true` AND add a scope that includes worktree paths. If this introduces real risk (broad scope) or if enabling it requires a deeper security review, **stop and ask** — do not silently widen FS scope.

**Steps:**

1. **Create the file-kind classifier.** Write `apps/desktop/src/lib/file-kind.ts`:

   ```ts
   export type FileKind = "image" | "svg" | "binary" | "text";

   const IMAGE_EXTS = new Set([
     "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "apng", "tiff",
   ]);

   const BINARY_EXTS = new Set([
     // Executables / libs
     "exe", "dll", "so", "dylib", "wasm", "o", "a", "lib",
     // Archives
     "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "tgz",
     // Media
     "mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg",
     // Documents
     "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
     // Fonts
     "woff", "woff2", "ttf", "otf", "eot",
     // DBs
     "sqlite", "sqlite3", "db",
     // Images we explicitly route to image handler — listed in IMAGE_EXTS.
   ]);

   export function classifyFile(path: string): FileKind {
     const dot = path.lastIndexOf(".");
     if (dot === -1 || dot === path.length - 1) return "text";
     const ext = path.slice(dot + 1).toLowerCase();
     if (ext === "svg") return "svg";
     if (IMAGE_EXTS.has(ext)) return "image";
     if (BINARY_EXTS.has(ext)) return "binary";
     return "text";
   }

   export function formatBytes(n: number): string {
     if (n < 1024) return `${n} B`;
     if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
     if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
     return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
   }

   export const TEXT_SIZE_CAP_BYTES = 1024 * 1024; // 1 MB
   ```

2. **Verify the asset protocol.** Run:

   ```bash
   grep -n "assetProtocol\|app\.security" backend/tauri/tauri.conf.json
   ```

   If `assetProtocol.enable` is not set or is `false`, the `<img src={convertFileSrc(...)}>` URLs will not load. Open `backend/tauri/tauri.conf.json` and ensure under `app.security`:

   ```json
   "assetProtocol": {
     "enable": true,
     "scope": ["**"]
   }
   ```

   If this scope is broader than the project already permits, **stop and discuss with the human** before relaxing it. (Worktree paths vary per machine; we want the asset protocol enabled with worktree-spanning scope but tight enough to not become a footgun.)

3. **Rewrite `FileViewer.tsx`** to dispatch by kind. Full file:

   ```tsx
   import { useEffect, useMemo, useState, type ReactNode } from "react";
   import { readTextFile, stat } from "@tauri-apps/plugin-fs";
   import { convertFileSrc } from "@tauri-apps/api/core";
   import { File } from "@pierre/diffs/react";
   import { useUIStore } from "../store";
   import { classifyFile, formatBytes, TEXT_SIZE_CAP_BYTES, type FileKind } from "../lib/file-kind";

   function Placeholder({
     tone = "muted",
     children,
   }: {
     tone?: "muted" | "error";
     children: ReactNode;
   }) {
     const color = tone === "error" ? "text-destructive" : "text-muted-foreground";
     return (
       <div className={`flex flex-col items-center justify-center h-full gap-2 text-sm ${color}`}>
         {children}
       </div>
     );
   }

   export function FileViewer() {
     const selectedWorktree = useUIStore((s) => s.selectedWorktree);
     const wtPath = selectedWorktree?.path ?? null;
     const selectedFilePath = useUIStore((s) =>
       wtPath ? (s.worktreeNavStates[wtPath]?.selectedFilePath ?? null) : null
     );

     const fullPath = wtPath && selectedFilePath ? `${wtPath}/${selectedFilePath}` : null;
     const initialKind: FileKind | null = selectedFilePath ? classifyFile(selectedFilePath) : null;

     // SVG-as-source override — true means render the SVG XML in the code view
     // instead of as an image. Resets when the path changes.
     const [svgSourceMode, setSvgSourceMode] = useState(false);
     // Override for "load anyway" on >1MB text files. Resets per-path.
     const [forceLoadLarge, setForceLoadLarge] = useState(false);

     useEffect(() => {
       setSvgSourceMode(false);
       setForceLoadLarge(false);
     }, [fullPath]);

     const [size, setSize] = useState<number | null>(null);
     const [contents, setContents] = useState<string | null>(null);
     const [error, setError] = useState<string | null>(null);

     // Stat first to learn the size, then decide whether to read.
     useEffect(() => {
       setSize(null);
       setContents(null);
       setError(null);
       if (!fullPath) return;
       let cancelled = false;
       (async () => {
         try {
           const s = await stat(fullPath);
           if (cancelled) return;
           setSize(s.size);
         } catch (e) {
           if (!cancelled) setError(String(e));
         }
       })();
       return () => {
         cancelled = true;
       };
     }, [fullPath]);

     const effectiveKind: FileKind | null = useMemo(() => {
       if (!initialKind) return null;
       if (initialKind === "svg") return svgSourceMode ? "text" : "svg";
       return initialKind;
     }, [initialKind, svgSourceMode]);

     // Load text contents only when needed.
     const shouldLoadText =
       fullPath !== null &&
       size !== null &&
       (effectiveKind === "text" || effectiveKind === "svg" /* unreachable here, but explicit */) &&
       (size <= TEXT_SIZE_CAP_BYTES || forceLoadLarge);

     useEffect(() => {
       if (!shouldLoadText || !fullPath) return;
       let cancelled = false;
       (async () => {
         try {
           const text = await readTextFile(fullPath);
           if (!cancelled) setContents(text);
         } catch (e) {
           if (!cancelled) setError(String(e));
         }
       })();
       return () => {
         cancelled = true;
       };
     }, [shouldLoadText, fullPath]);

     const file = useMemo(() => {
       if (!selectedFilePath || contents === null) return null;
       return { name: selectedFilePath, contents };
     }, [selectedFilePath, contents]);

     if (!selectedFilePath) {
       return <Placeholder>Select a file in the Files tab to view its contents</Placeholder>;
     }

     if (error) {
       return (
         <Placeholder tone="error">
           <div>Failed to read {selectedFilePath}:</div>
           <div className="text-xs">{error}</div>
         </Placeholder>
       );
     }

     if (size === null) {
       return <Placeholder>Loading {selectedFilePath}…</Placeholder>;
     }

     if (effectiveKind === "image" || initialKind === "svg") {
       return (
         <div className="flex flex-col items-center justify-center h-full gap-3 bg-[repeating-conic-gradient(theme(colors.muted)_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
           <img
             src={convertFileSrc(fullPath!)}
             alt={selectedFilePath}
             className="max-w-full max-h-[80%] object-contain"
           />
           <div className="text-xs text-muted-foreground">
             {selectedFilePath} · {formatBytes(size)}
             {initialKind === "svg" && (
               <button
                 onClick={() => setSvgSourceMode(true)}
                 className="ml-2 underline hover:text-foreground"
               >
                 View source
               </button>
             )}
           </div>
         </div>
       );
     }

     if (effectiveKind === "binary") {
       return (
         <Placeholder>
           <div className="text-base">Binary file</div>
           <div>{selectedFilePath} · {formatBytes(size)}</div>
         </Placeholder>
       );
     }

     // Text path
     if (size > TEXT_SIZE_CAP_BYTES && !forceLoadLarge) {
       return (
         <Placeholder>
           <div>{selectedFilePath} is {formatBytes(size)}</div>
           <div className="text-xs">Files larger than 1 MB are not previewed by default.</div>
           <button
             onClick={() => setForceLoadLarge(true)}
             className="mt-2 px-3 py-1 rounded border text-xs hover:bg-accent"
           >
             Load anyway
           </button>
         </Placeholder>
       );
     }

     if (!file) {
       return <Placeholder>Loading {selectedFilePath}…</Placeholder>;
     }

     return (
       <div className="h-full overflow-auto">
         <File file={file} />
       </div>
     );
   }
   ```

4. **Type-check.**

   ```bash
   cd apps/desktop && bun run typecheck
   ```

   Must be clean.

5. **Smoke test.** Run `bun run dev` and exercise:

   - Click a `.png` in the worktree → image renders inline with a checkered backdrop.
   - Click a `.svg` → renders rendered (vector); click "View source" → tokenized XML.
   - Click a binary (e.g. a `.wasm`, `.zip`, or a TTF font from `node_modules`) → "Binary file - X.X MB" card.
   - Click a small text file → renders normally as Phase 1.
   - If the worktree contains a text file > 1MB (e.g. `bun.lock` is often ~1MB) → "Files larger than 1 MB are not previewed by default." card with "Load anyway" button. Click it → file loads.
   - Switching files resets all overrides (SVG-source toggle, load-anyway).

6. **Commit:**

   ```bash
   git add apps/desktop/src/lib/file-kind.ts apps/desktop/src/components/FileViewer.tsx
   # If you modified tauri.conf.json:
   git add backend/tauri/tauri.conf.json
   git commit -m "feat(file-tree): handle images, binaries, large files in viewer"
   ```

**Done When:**

- [ ] `lib/file-kind.ts` exists with `classifyFile`, `formatBytes`, `TEXT_SIZE_CAP_BYTES`
- [ ] `FileViewer` dispatches by kind (image / svg / binary / text)
- [ ] SVG renders rendered, source toggle works
- [ ] Binary card shows file path + size
- [ ] >1MB text shows "load anyway" prompt; clicking it loads
- [ ] Asset protocol scope is configured (or confirmed already in place)
- [ ] `bun run typecheck` passes
- [ ] Visual smoke covers all four kinds
- [ ] Changes committed
