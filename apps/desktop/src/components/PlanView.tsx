import { useState, useEffect, useCallback, useMemo } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useUIStore } from "../store";
import { usePlanAnnotationActions } from "../hooks/usePlanAnnotationActions";
import { PlanToolbar } from "./PlanToolbar";
import { PlanAnnotationForm } from "./PlanAnnotationForm";

export function PlanView() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path ?? "";
  const navState = useUIStore((s) =>
    wtPath ? (s.worktreeNavStates[wtPath] ?? null) : null
  );

  const {
    activePlan,
    plans,
    planAnnotations,
    handleCreate,
    handleApprove,
    handleRequestChanges,
  } = usePlanAnnotationActions();

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [pendingLine, setPendingLine] = useState<number | null>(null);

  // Auto-select latest pending plan if none selected
  useEffect(() => {
    if (navState?.activePlanId || plans.length === 0 || !wtPath) return;
    const pending = plans.find((p) => p.status === "pending") ?? plans[0];
    if (pending) {
      useUIStore.getState().updateWorktreeNavState(wtPath, {
        activePlanId: pending.id,
      });
    }
  }, [plans, navState?.activePlanId, wtPath]);

  // Load markdown file
  useEffect(() => {
    if (!activePlan) {
      setMarkdown(null);
      setLines([]);
      return;
    }
    readTextFile(activePlan.plan_path)
      .then((content) => {
        setMarkdown(content);
        setLines(content.split("\n"));
      })
      .catch(() => {
        setMarkdown(null);
        setLines([]);
      });
  }, [activePlan?.plan_path]);

  const handleLineClick = useCallback((lineNumber: number) => {
    setPendingLine(lineNumber);
  }, []);

  const handleAnnotationSubmit = useCallback(
    (body: string) => {
      if (pendingLine == null) return;
      handleCreate(body, pendingLine);
      setPendingLine(null);
    },
    [pendingLine, handleCreate]
  );

  const handleClose = useCallback(() => {
    if (!wtPath) return;
    useUIStore.getState().updateWorktreeNavState(wtPath, {
      activeTab: "diff",
      activePlanId: null,
    });
  }, [wtPath]);

  // Build a set of lines that have annotations for gutter indicators
  const annotatedLines = useMemo(
    () => new Set(planAnnotations.map((a) => a.line_number)),
    [planAnnotations]
  );

  if (!activePlan) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No plan to review
      </div>
    );
  }

  if (markdown === null) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading plan...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PlanToolbar
        plan={activePlan}
        onApprove={handleApprove}
        onRequestChanges={handleRequestChanges}
        onClose={handleClose}
      />
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-4xl mx-auto py-6">
          {lines.map((line, index) => {
            const lineNumber = index + 1;
            const hasAnnotation = annotatedLines.has(lineNumber);

            return (
              <div key={lineNumber}>
                <div
                  className="flex group"
                  data-plan-line={lineNumber}
                >
                  {/* Line gutter */}
                  <div
                    className={`shrink-0 w-12 text-right pr-3 py-0.5 text-sm font-mono select-none cursor-pointer ${
                      hasAnnotation
                        ? "text-blue-400"
                        : "text-muted-foreground/40 group-hover:text-muted-foreground"
                    }`}
                    onClick={() => handleLineClick(lineNumber)}
                    title={`Line ${lineNumber} — click to annotate`}
                  >
                    {hasAnnotation ? (
                      <span className="inline-flex items-center justify-end w-full">
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                          <circle cx="8" cy="8" r="4" />
                        </svg>
                      </span>
                    ) : (
                      lineNumber
                    )}
                  </div>
                  {/* Line content */}
                  <div className="flex-1 min-w-0 px-4 py-0.5">
                    <pre className="text-sm text-foreground font-mono whitespace-pre-wrap break-words m-0 p-0 bg-transparent">
                      {line || "\u00A0"}
                    </pre>
                  </div>
                </div>
                {/* Inline annotation form */}
                {pendingLine === lineNumber && (
                  <PlanAnnotationForm
                    lineNumber={lineNumber}
                    onSubmit={handleAnnotationSubmit}
                    onCancel={() => setPendingLine(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
