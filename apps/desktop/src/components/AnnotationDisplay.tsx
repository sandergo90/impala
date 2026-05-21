import { memo } from "react";
import { openFileInEditor } from "../lib/open-file-in-editor";
import { openFileTab } from "../lib/tab-actions";
import type { Annotation } from "../types";
import type { ContextLine } from "../lib/code-context";
import { formatRelativeTime } from "../lib/utils";

interface AnnotationDisplayProps {
  annotation: Annotation;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
}

function parseContext(raw: string | undefined): ContextLine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const AnnotationDisplay = memo(function AnnotationDisplay({
  annotation,
  onResolve,
  onDelete,
}: AnnotationDisplayProps) {
  const resolved = annotation.resolved;
  const context = parseContext(annotation.code_context);
  const sideLabel = annotation.side === "left" ? "L" : "R";

  const openLocation = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      openFileInEditor(
        `${annotation.repo_path}/${annotation.file_path}`,
        annotation.line_number
      );
    } else {
      openFileTab(annotation.repo_path, annotation.file_path, {
        line: annotation.line_number,
      });
    }
  };

  return (
    <div className={`group px-3 py-2 ${resolved ? "opacity-50" : ""}`}>
      {context.length > 0 ? (
        <div className="flex flex-col gap-px">
          {context.map((line) => {
            const isHit = line.lineNumber === annotation.line_number;
            return (
              <div key={line.lineNumber} className="flex gap-2">
                <span className="w-7 shrink-0 select-none text-right font-mono text-xs text-muted-foreground/60">
                  {line.lineNumber}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate rounded-sm px-1.5 font-mono text-xs ${
                    isHit
                      ? "bg-green-500/10 text-green-300"
                      : "text-muted-foreground"
                  }`}
                >
                  {line.text || " "}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <span
          className="cursor-pointer font-mono text-xs text-blue-400 hover:underline"
          title="Click to open in Impala. Cmd+click to open in your IDE."
          onClick={openLocation}
        >
          {sideLabel}:{annotation.line_number}
        </span>
      )}

      <div className="mt-1.5 flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-foreground">
          {annotation.body}
        </p>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-xs text-muted-foreground/60">
            {formatRelativeTime(annotation.created_at)}
          </span>
          {resolved ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onResolve(annotation.id, false);
              }}
              title="Unresolve"
              className="text-xs text-green-400"
            >
              ✓ Resolved
            </button>
          ) : (
            <div className="flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve(annotation.id, true);
                }}
                title="Resolve"
                className="text-xs text-green-400 hover:text-green-300"
              >
                ✓
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(annotation.id);
                }}
                title="Delete"
                className="text-xs text-muted-foreground hover:text-red-400"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
