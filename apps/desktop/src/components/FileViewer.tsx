import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "@/lib/invoke";
import { listen } from "@tauri-apps/api/event";
import { useEditorDocsStore, type SaveOutcome } from "../stores/editor-docs";
import { buildDocumentKey, getCurrent, getBaseline } from "../lib/editor-buffer-registry";
import { classifyFile, formatBytes, TEXT_SIZE_CAP_BYTES, type FileKind } from "../lib/file-kind";
import { sanitizeEventId } from "../lib/sanitize-event-id";
import { OpenInEditorButton } from "./OpenInEditorButton";
import { RevealInFinderButton } from "./RevealInFinderButton";
import { CodeEditor, detectLanguage, type CodeEditorHandle } from "./CodeEditor";
import { MarkdownPreview } from "./MarkdownPreview";

function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

interface FsEvent {
  kind: "create" | "update" | "delete" | "rename" | "overflow";
  path?: string | null;
  oldPath?: string | null;
  isDirectory?: boolean | null;
}

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

export function FileViewer({
  worktreePath,
  path,
}: {
  worktreePath: string;
  path: string;
}) {
  // Prop-driven so two panes can each show a different file. The leaf decides
  // "which file"; the pane-agnostic editor-docs store keeps buffers keyed by
  // worktreePath+path, so backgrounding/restore keeps working.
  const wtPath = worktreePath;
  const selectedFilePath = path;

  const fullPath = wtPath && selectedFilePath ? `${wtPath}/${selectedFilePath}` : null;
  const initialKind: FileKind | null = selectedFilePath ? classifyFile(selectedFilePath) : null;

  const [svgSourceMode, setSvgSourceMode] = useState(false);
  const [htmlSourceMode, setHtmlSourceMode] = useState(false);
  // Per-file markdown view choice (rendered "preview" vs raw "source"),
  // defaulting to preview. Keyed by docKey so switching files remembers it
  // for the session.
  const [markdownViewModes, setMarkdownViewModes] = useState<
    Record<string, "preview" | "source">
  >({});
  const [forceLoadLarge, setForceLoadLarge] = useState(false);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [htmlError, setHtmlError] = useState<string | null>(null);
  useEffect(() => {
    setSvgSourceMode(false);
    setHtmlSourceMode(false);
    setForceLoadLarge(false);
    setHtmlContent(null);
    setHtmlError(null);
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
        const size = await invoke<number>("stat_file_size", { absolutePath: fullPath });
        if (!cancelled) setSize(size);
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
    if (initialKind === "html") return htmlSourceMode ? "text" : "html";
    return initialKind;
  }, [initialKind, svgSourceMode, htmlSourceMode]);

  const shouldLoadText =
    fullPath !== null &&
    size !== null &&
    effectiveKind === "text" &&
    (size <= TEXT_SIZE_CAP_BYTES || forceLoadLarge);

  useEffect(() => {
    if (effectiveKind !== "html" || !fullPath || size === null) return;
    if (size > TEXT_SIZE_CAP_BYTES && !forceLoadLarge) return;
    if (htmlContent !== null || htmlError !== null) return;
    let cancelled = false;
    invoke<{ content: string; revision: string }>("read_file_with_revision", {
      absolutePath: fullPath,
    })
      .then((res) => {
        if (!cancelled) setHtmlContent(res.content);
      })
      .catch((e) => {
        if (!cancelled) setHtmlError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveKind, fullPath, size, forceLoadLarge, htmlContent, htmlError]);

  // Keep the HTML preview in sync with disk: the load effect above only runs
  // while htmlContent is null, so reset it when the watcher reports a change
  // to the open file. Deletes are skipped — keep showing the last content,
  // matching refreshIfClean's behavior for text docs.
  useEffect(() => {
    if (effectiveKind !== "html" || !wtPath || !selectedFilePath) return;
    let cancelled = false;
    const eventName = `fs-event-${sanitizeEventId(wtPath)}`;
    const unlistenPromise = listen<FsEvent>(eventName, (event) => {
      if (cancelled) return;
      const { kind, path } = event.payload;
      if (kind === "delete" || (kind !== "overflow" && path !== selectedFilePath)) return;
      setHtmlContent(null);
      setHtmlError(null);
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [effectiveKind, wtPath, selectedFilePath]);

  const docKey = wtPath && selectedFilePath ? buildDocumentKey(wtPath, selectedFilePath) : null;
  const doc = useEditorDocsStore((s) => (docKey ? s.docs[docKey] : undefined));
  const loadDoc = useEditorDocsStore((s) => s.loadDoc);
  const updateDraft = useEditorDocsStore((s) => s.updateDraft);
  const saveDoc = useEditorDocsStore((s) => s.saveDoc);
  const reloadFromDisk = useEditorDocsStore((s) => s.reloadFromDisk);
  const pendingTarget = useEditorDocsStore((s) =>
    docKey ? s.pendingTargets[docKey] : undefined,
  );
  const clearPendingTarget = useEditorDocsStore((s) => s.clearPendingTarget);

  const editorRef = useRef<CodeEditorHandle | null>(null);

  useEffect(() => {
    if (!docKey || !pendingTarget) return;
    // Defer to next frame so a freshly-mounted CodeEditor has had a chance
    // to attach its handle.
    const id = requestAnimationFrame(() => {
      editorRef.current?.goto(pendingTarget.line, pendingTarget.col);
      clearPendingTarget(docKey);
    });
    return () => cancelAnimationFrame(id);
  }, [docKey, pendingTarget, clearPendingTarget]);

  useEffect(() => {
    if (!shouldLoadText || !wtPath || !selectedFilePath) return;
    if (doc && doc.status === "ready" && doc.loadError === null) return;
    void loadDoc(wtPath, selectedFilePath);
  }, [shouldLoadText, wtPath, selectedFilePath, doc?.status, doc?.loadError, loadDoc]);

  const setExternalChange = useEditorDocsStore((s) => s.setExternalChange);
  const refreshIfClean = useEditorDocsStore((s) => s.refreshIfClean);

  // Catch up with disk when this viewer (re)mounts. TabbedTerminals mounts
  // only the active tab, so the fs-event listener below doesn't exist while
  // the file tab is backgrounded — external changes from that period were
  // never seen. No-ops when the on-disk revision matches the baseline.
  useEffect(() => {
    if (!shouldLoadText || !docKey) return;
    void refreshIfClean(docKey);
  }, [shouldLoadText, docKey, refreshIfClean]);

  useEffect(() => {
    if (!wtPath) return;
    let cancelled = false;
    const eventName = `fs-event-${sanitizeEventId(wtPath)}`;
    const unlistenPromise = listen<FsEvent>(eventName, (event) => {
      if (cancelled) return;
      const payload = event.payload;
      if (payload.kind === "overflow") {
        const docs = useEditorDocsStore.getState().docs;
        for (const d of Object.values(docs)) {
          if (d.worktreePath !== wtPath) continue;
          if (d.dirty) setExternalChange(d.key, true);
          else void refreshIfClean(d.key);
        }
        return;
      }
      if (!payload.path) return;
      const key = buildDocumentKey(wtPath, payload.path);
      const target = useEditorDocsStore.getState().docs[key];
      if (!target) return;
      // Clean docs follow the disk: reload silently so an open file being
      // rewritten externally (e.g. an agent updating a plan) stays fresh.
      if (!target.dirty) {
        void refreshIfClean(key);
        return;
      }
      // Don't flag changes we caused ourselves: if the registry's baseline
      // already matches its current (i.e. no draft ahead of disk), skip.
      if (getBaseline(key) === getCurrent(key)) return;
      setExternalChange(key, true);
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [wtPath, setExternalChange, refreshIfClean]);

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
  if (effectiveKind === "html") {
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
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1 border-b border-border text-xs shrink-0">
          <span className="truncate text-muted-foreground font-mono">
            {selectedFilePath}
          </span>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <button
              onClick={() => setHtmlSourceMode(true)}
              className="px-2 py-0.5 rounded border text-xs hover:bg-accent"
            >
              View source
            </button>
            <OpenInEditorButton worktreePath={wtPath!} filePath={selectedFilePath} />
            <RevealInFinderButton worktreePath={wtPath!} filePath={selectedFilePath} />
          </div>
        </div>
        {htmlError ? (
          <Placeholder tone="error">
            <div>Failed to read {selectedFilePath}:</div>
            <div className="text-xs">{htmlError}</div>
          </Placeholder>
        ) : htmlContent === null ? (
          <Placeholder>Loading {selectedFilePath}…</Placeholder>
        ) : (
          <iframe
            srcDoc={htmlContent}
            title={selectedFilePath}
            sandbox="allow-scripts"
            className="flex-1 min-h-0 w-full border-0 bg-white"
          />
        )}
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
  const isMarkdown = isMarkdownPath(selectedFilePath);
  const markdownView = docKey ? markdownViewModes[docKey] ?? "preview" : "preview";
  const setMarkdownView = (mode: "preview" | "source") => {
    if (docKey) setMarkdownViewModes((m) => ({ ...m, [docKey]: mode }));
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {wtPath && selectedFilePath && (
        <div className="flex items-center justify-between px-3 py-1 border-b border-border text-xs shrink-0">
          <span className="truncate text-muted-foreground font-mono">
            {doc.dirty && <span className="text-foreground mr-1" aria-label="Unsaved">●</span>}
            {selectedFilePath}
          </span>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            {isMarkdown && (
              <div className="flex items-center rounded border border-border overflow-hidden mr-1">
                <button
                  onClick={() => setMarkdownView("preview")}
                  className={`px-2 py-0.5 ${
                    markdownView === "preview"
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                >
                  Preview
                </button>
                <button
                  onClick={() => setMarkdownView("source")}
                  className={`px-2 py-0.5 border-l border-border ${
                    markdownView === "source"
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                >
                  Markdown
                </button>
              </div>
            )}
            <OpenInEditorButton worktreePath={wtPath} filePath={selectedFilePath} />
            <RevealInFinderButton worktreePath={wtPath} filePath={selectedFilePath} />
          </div>
        </div>
      )}
      {doc.hasExternalDiskChange && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-accent text-xs">
          <span>This file changed on disk while you were editing it.</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void reloadFromDisk(docKey!)}
              className="px-2 py-0.5 rounded border hover:bg-foreground/5"
            >
              Reload from disk
            </button>
            <button
              onClick={() => setExternalChange(docKey!, false)}
              className="px-2 py-0.5 rounded border hover:bg-foreground/5"
            >
              Keep my changes
            </button>
          </div>
        </div>
      )}
      {isMarkdown && markdownView === "preview" ? (
        <MarkdownPreview
          key={docKey}
          content={bufferContent}
          filePath={selectedFilePath}
          worktreePath={wtPath!}
          className="flex-1 min-h-0"
        />
      ) : (
        <CodeEditor
          key={docKey}
          editorRef={editorRef}
          value={bufferContent}
          language={language}
          plain={isMarkdown}
          onChange={(next) => updateDraft(docKey!, next)}
          onSave={handleSave}
          className="flex-1 min-h-0"
        />
      )}
    </div>
  );
}
