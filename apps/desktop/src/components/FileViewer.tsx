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
    effectiveKind === "text" &&
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

  if (effectiveKind === "image" || effectiveKind === "svg") {
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
