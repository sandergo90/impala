import { memo } from "react";
import type { PlanAnnotation } from "../types";
import { formatRelativeTime } from "../lib/utils";

interface PlanAnnotationDisplayProps {
  annotation: PlanAnnotation;
  selected: boolean;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
}

export const PlanAnnotationDisplay = memo(function PlanAnnotationDisplay({
  annotation,
  selected,
  onResolve,
  onDelete,
}: PlanAnnotationDisplayProps) {
  const resolved = annotation.resolved;

  return (
    <div
      data-annotation-card={annotation.id}
      className={`flex gap-2 p-2 rounded border text-md transition-colors ${
        resolved
          ? "opacity-50 border-border/50"
          : selected
            ? "border-primary/50 bg-primary/5"
            : "border-border"
      }`}
    >
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-accent text-accent-foreground flex items-center justify-center text-md font-semibold">
        You
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-1 font-mono truncate">
          "{annotation.original_text}"
        </div>
        <p className="mt-0.5 text-foreground whitespace-pre-wrap break-words">
          {annotation.body}
        </p>
        <div className="text-xs text-muted-foreground mt-1">
          {formatRelativeTime(annotation.created_at)}
        </div>
      </div>
      <div className="flex flex-col gap-1 flex-shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onResolve(annotation.id, !resolved);
          }}
          title={resolved ? "Unresolve" : "Resolve"}
          className={`px-1.5 py-0.5 rounded text-md ${
            resolved
              ? "bg-green-800/30 text-green-400"
              : "hover:bg-accent text-muted-foreground hover:text-foreground"
          }`}
        >
          {resolved ? "Resolved" : "Resolve"}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(annotation.id);
          }}
          title="Delete"
          className="px-1.5 py-0.5 rounded text-md text-muted-foreground hover:text-red-400 hover:bg-red-900/20"
        >
          &times;
        </button>
      </div>
    </div>
  );
});
