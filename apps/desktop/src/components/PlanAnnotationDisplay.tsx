import { memo } from "react";
import type { PlanAnnotation } from "../types";
import { formatRelativeTime } from "../lib/utils";

interface PlanAnnotationDisplayProps {
  annotation: PlanAnnotation;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
}

export const PlanAnnotationDisplay = memo(function PlanAnnotationDisplay({
  annotation,
  onResolve,
  onDelete,
}: PlanAnnotationDisplayProps) {
  const resolved = annotation.resolved;

  return (
    <div
      className={`flex gap-2 p-2 rounded border text-md ${
        resolved ? "opacity-50 border-border/50" : "border-border"
      }`}
    >
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-accent text-accent-foreground flex items-center justify-center text-md font-semibold">
        You
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-mono truncate max-w-[120px]" title={annotation.original_text}>
            &ldquo;{annotation.original_text}&rdquo;
          </span>
          <span>{formatRelativeTime(annotation.created_at)}</span>
        </div>
        <p className="mt-0.5 text-foreground whitespace-pre-wrap break-words">
          {annotation.body}
        </p>
      </div>
      <div className="flex flex-col gap-1 flex-shrink-0">
        <button
          onClick={() => onResolve(annotation.id, !resolved)}
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
          onClick={() => onDelete(annotation.id)}
          title="Delete"
          className="px-1.5 py-0.5 rounded text-md text-muted-foreground hover:text-red-400 hover:bg-red-900/20"
        >
          &times;
        </button>
      </div>
    </div>
  );
});
