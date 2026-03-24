import type { Annotation } from "../types";

interface AnnotationDisplayProps {
  annotation: Annotation;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
}

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export function AnnotationDisplay({
  annotation,
  onResolve,
  onDelete,
}: AnnotationDisplayProps) {
  const sideLabel = annotation.side === "left" ? "L" : "R";
  const resolved = annotation.resolved;

  return (
    <div
      className={`flex gap-2 p-2 rounded border text-xs ${
        resolved
          ? "opacity-50 border-border/50"
          : "border-border"
      }`}
    >
      {/* Avatar placeholder */}
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-accent text-accent-foreground flex items-center justify-center text-[10px] font-semibold">
        You
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-mono">
            {sideLabel}:{annotation.line_number}
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
          className={`px-1.5 py-0.5 rounded text-[10px] ${
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
          className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-red-400 hover:bg-red-900/20"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
