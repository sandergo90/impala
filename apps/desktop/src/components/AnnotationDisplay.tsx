import { memo, useMemo } from "react";
import { Check, X } from "lucide-react";
import { openFileInEditor } from "../lib/open-file-in-editor";
import { openFileTab } from "../lib/tab-actions";
import type { Annotation } from "../types";
import type { ContextLine } from "../lib/code-context";
import { formatRelativeTime } from "../lib/utils";

interface AnnotationDisplayProps {
  annotation: Annotation;
  onJump: () => void;
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
  onJump,
  onResolve,
  onDelete,
}: AnnotationDisplayProps) {
  const resolved = annotation.resolved;
  const context = useMemo(
    () => parseContext(annotation.code_context),
    [annotation.code_context]
  );
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
    <div role="listitem" className="group px-3 py-2">
      {context.length > 0 ? (
        // The code-anchor block is the jump control, so the primary action is
        // reachable by keyboard and named for assistive tech.
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onJump();
          }}
          aria-label={`Jump to line ${annotation.line_number}`}
          className="flex w-full cursor-pointer flex-col gap-px rounded-sm text-left"
        >
          {context.map((line) => {
            const isHit = line.lineNumber === annotation.line_number;
            return (
              <span key={line.lineNumber} className="flex w-full gap-2">
                <span className="w-7 shrink-0 select-none text-right font-mono text-xs text-muted-foreground">
                  {line.lineNumber}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate rounded-sm px-1.5 font-mono text-xs ${
                    isHit
                      ? "bg-success/15 text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {line.text || " "}
                </span>
              </span>
            );
          })}
        </button>
      ) : (
        <button
          type="button"
          className="cursor-pointer font-mono text-xs text-[var(--color-link)] hover:underline"
          title="Click to open in Impala. Cmd+click to open in your IDE."
          onClick={openLocation}
        >
          {sideLabel}:{annotation.line_number}
        </button>
      )}

      <div className="mt-1.5 flex items-start gap-2">
        <p
          className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${
            resolved ? "text-muted-foreground line-through" : "text-foreground"
          }`}
        >
          {annotation.body}
        </p>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(annotation.created_at)}
          </span>
          {resolved ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onResolve(annotation.id, false);
              }}
              title="Unresolve"
              aria-label="Unresolve annotation"
              className="flex items-center gap-1 rounded px-1 text-xs text-success hover:bg-foreground/10"
            >
              <Check aria-hidden="true" className="size-3.5" />
              Resolved
            </button>
          ) : (
            <div className="flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve(annotation.id, true);
                }}
                title="Resolve"
                aria-label="Resolve annotation"
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-success"
              >
                <Check aria-hidden="true" className="size-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(annotation.id);
                }}
                title="Delete"
                aria-label="Delete annotation"
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-destructive"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
