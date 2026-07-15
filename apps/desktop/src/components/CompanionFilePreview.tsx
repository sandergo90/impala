import { useEffect } from "react";
import { useUIStore } from "../store";
import { FileViewer } from "./FileViewer";

/**
 * Companion mode's single-file preview: shown in place of the diff when a
 * file is opened (Cmd+P, Files panel, diff headers, markdown links). One file
 * at a time, no tab surface — Esc or the close bar returns to the diff.
 */
export function CompanionFilePreview({
  worktreePath,
  path,
}: {
  worktreePath: string;
  path: string;
}) {
  const close = () => useUIStore.getState().setCompanionFilePreview(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Leave Esc alone when something else owns it: an open overlay
      // (command palette, file finder, dialogs) or a handled editor key
      // (e.g. CodeMirror dismissing autocomplete calls preventDefault).
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[cmdk-root], [role="dialog"]')) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border/50 shrink-0">
        <button
          onClick={close}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m12 19-7-7 7-7" />
            <path d="M19 12H5" />
          </svg>
          Back to diff
        </button>
        <kbd className="text-[10px] text-muted-foreground/40">esc</kbd>
      </div>
      <div className="flex-1 min-h-0">
        <FileViewer worktreePath={worktreePath} filePath={path} />
      </div>
    </div>
  );
}
