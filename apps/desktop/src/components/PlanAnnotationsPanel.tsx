import { useMemo, useEffect, useRef } from "react";
import { useUIStore } from "../store";
import { usePlanAnnotationActions } from "../hooks/usePlanAnnotationActions";
import { useSelectedPlanAnnotation } from "../hooks/useSelectedPlanAnnotation";
import { PlanAnnotationDisplay } from "./PlanAnnotationDisplay";

export function PlanAnnotationsPanel() {
  const showResolved = useUIStore((s) => s.showResolved);
  const setShowResolved = useUIStore((s) => s.setShowResolved);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useSelectedPlanAnnotation();

  const { planAnnotations, handleResolve, handleDelete } =
    usePlanAnnotationActions();

  const filtered = useMemo(() => {
    const items = planAnnotations.filter(
      (a) => showResolved || !a.resolved
    );
    items.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return items;
  }, [planAnnotations, showResolved]);

  const hasAnnotations = planAnnotations.length > 0;

  // Auto-scroll sidebar card into view when selected (e.g., from clicking inline highlight)
  useEffect(() => {
    if (!selectedAnnotationId || !listRef.current) return;
    const card = listRef.current.querySelector(
      `[data-annotation-card="${selectedAnnotationId}"]`
    );
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedAnnotationId]);

  if (!hasAnnotations) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground/90 gap-2 px-4">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-muted-foreground/90"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="text-sm text-center">
          Select text in the plan to annotate
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        <button
          onClick={() => setShowResolved(!showResolved)}
          className={`px-2 py-0.5 rounded text-sm ${
            showResolved
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Resolved
        </button>
      </div>
      <div ref={listRef} className="overflow-y-auto flex-1 min-h-0">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground/90 text-center">
            {showResolved ? "No annotations" : "No unresolved annotations"}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 p-2">
            {filtered.map((a) => (
              <div
                key={a.id}
                className="cursor-pointer"
                onClick={() => setSelectedAnnotationId(a.id)}
              >
                <PlanAnnotationDisplay
                  annotation={a}
                  selected={a.id === selectedAnnotationId}
                  onResolve={handleResolve}
                  onDelete={handleDelete}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
