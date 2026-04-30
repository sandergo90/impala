import { useEffect, useMemo, useState, type ReactNode } from "react";
import { stat } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useUIStore } from "../store";
import { useEditorDocsStore, type SaveOutcome } from "../stores/editor-docs";
import { buildDocumentKey, getCurrent } from "../lib/editor-buffer-registry";
import { classifyFile, formatBytes, TEXT_SIZE_CAP_BYTES, type FileKind } from "../lib/file-kind";
import { OpenInEditorButton } from "./OpenInEditorButton";
import { RevealInFinderButton } from "./RevealInFinderButton";
import { CodeEditor, detectLanguage } from "./CodeEditor";

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
  const activeTabId = useUIStore((s) =>
    wtPath ? s.worktreeNavStates[wtPath]?.activeTerminalsTab ?? null : null,
  );
  const selectedFilePath = useUIStore((s) => {
    if (!wtPath || !activeTabId) return null;
    const tab = s.worktreeNavStates[wtPath]?.userTabs.find((t) => t.id === activeTabId);
    return tab && tab.kind === "file" ? tab.path ?? null : null;
  });

  const fullPath = wtPath && selectedFilePath ? `${wtPath}/${selectedFilePath}` : null;
  const initialKind: FileKind | null = selectedFilePath ? classifyFile(selectedFilePath) : null;

  const [svgSourceMode, setSvgSourceMode] = useState(false);
  const [forceLoadLarge, setForceLoadLarge] = useState(false);
  useEffect(() => {
    setSvgSourceMode(false);
    setForceLoadLarge(false);
  }, [fullPath]);

  const [size, setSize] = useState<number | null>(null);
  const [statError, setStatError] = useState<string | null>(null);

  useEffect(() => {
    setSize(null);
    setStatError(null);
    if (!fullPath) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await stat(fullPath);
        if (!cancelled) setSize(s.size);
      } catch (e) {
        if (!cancelled) setStatError(String(e));
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

  const shouldLoadText =
    fullPath !== null &&
    size !== null &&
    effectiveKind === "text" &&
    (size <= TEXT_SIZE_CAP_BYTES || forceLoadLarge);

  const docKey = wtPath && selectedFilePath ? buildDocumentKey(wtPath, selectedFilePath) : null;
  const doc = useEditorDocsStore((s) => (docKey ? s.docs[docKey] : undefined));
  const loadDoc = useEditorDocsStore((s) => s.loadDoc);
  const updateDraft = useEditorDocsStore((s) => s.updateDraft);
  const saveDoc = useEditorDocsStore((s) => s.saveDoc);
  const _reloadFromDisk = useEditorDocsStore((s) => s.reloadFromDisk);
  void _reloadFromDisk;

  useEffect(() => {
    if (!shouldLoadText || !wtPath || !selectedFilePath) return;
    if (doc && doc.status === "ready" && doc.loadError === null) return;
    void loadDoc(wtPath, selectedFilePath);
  }, [shouldLoadText, wtPath, selectedFilePath, doc, loadDoc]);

  if (!selectedFilePath) {
    return <Placeholder>Select a file in the Files tab to view its contents</Placeholder>;
  }
  if (statError) {
    return (
      <Placeholder tone="error">
        <div>Failed to read {selectedFilePath}:</div>
        <div className="text-xs">{statError}</div>
      </Placeholder>
    );
  }
  if (size === null) {
    return <Placeholder>Loading {selectedFilePath}…</Placeholder>;
  }
  if (effectiveKind === "image" || effectiveKind === "svg") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-[repeating-conic-gradient(var(--color-muted)_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
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

  if (!doc || doc.status === "loading") {
    return <Placeholder>Loading {selectedFilePath}…</Placeholder>;
  }
  if (doc.loadError) {
    return (
      <Placeholder tone="error">
        <div>Failed to read {selectedFilePath}:</div>
        <div className="text-xs">{doc.loadError}</div>
      </Placeholder>
    );
  }

  const handleSave = async (): Promise<void> => {
    if (!docKey) return;
    const result: SaveOutcome = await saveDoc(docKey);
    void result;
  };

  const language = detectLanguage(selectedFilePath);
  const bufferContent = getCurrent(docKey!);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {wtPath && selectedFilePath && (
        <div className="flex items-center justify-between px-3 py-1 border-b border-border text-xs shrink-0">
          <span className="truncate text-muted-foreground font-mono">
            {doc.dirty && <span className="text-foreground mr-1" aria-label="Unsaved">●</span>}
            {selectedFilePath}
          </span>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <OpenInEditorButton worktreePath={wtPath} filePath={selectedFilePath} />
            <RevealInFinderButton worktreePath={wtPath} filePath={selectedFilePath} />
          </div>
        </div>
      )}
      <CodeEditor
        key={docKey}
        value={bufferContent}
        language={language}
        onChange={(next) => updateDraft(docKey!, next)}
        onSave={handleSave}
        className="flex-1 min-h-0"
      />
    </div>
  );
}
