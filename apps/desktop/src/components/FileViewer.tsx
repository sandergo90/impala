import { useEffect, useMemo, useState, type ReactNode } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { File } from "@pierre/diffs/react";
import { useUIStore } from "../store";

function Placeholder({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error";
  children: ReactNode;
}) {
  const color = tone === "error" ? "text-destructive" : "text-muted-foreground";
  return (
    <div className={`flex items-center justify-center h-full text-sm ${color}`}>
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

  const [contents, setContents] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContents(null);
    setError(null);
    if (!wtPath || !selectedFilePath) return;
    const fullPath = `${wtPath}/${selectedFilePath}`;
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
  }, [wtPath, selectedFilePath]);

  const file = useMemo(() => {
    if (!selectedFilePath || contents === null) return null;
    return { name: selectedFilePath, contents };
  }, [selectedFilePath, contents]);

  if (!selectedFilePath) {
    return <Placeholder>Select a file in the Files tab to view its contents</Placeholder>;
  }

  if (error) {
    return <Placeholder tone="error">Failed to read {selectedFilePath}: {error}</Placeholder>;
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
