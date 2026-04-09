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
    planVersions,
    handleCreate,
    handleApprove,
    handleRequestChanges,
    handleOpenFile,
    handleOpenDirectory,
    handleSelectVersion,
  } = usePlanAnnotationActions();

  const [markdown, setMarkdown] = useState<string | null>(null);
  const lines = useMemo(() => markdown?.split("\n") ?? [], [markdown]);
  const [pendingLine, setPendingLine] = useState<number | null>(null);

  useEffect(() => {
    if (navState?.activePlanId || plans.length === 0 || !wtPath) return;
    const pending = plans.find((p) => p.status === "pending") ?? plans[0];
    if (pending) {
      useUIStore.getState().updateWorktreeNavState(wtPath, {
        activePlanId: pending.id,
      });
    }
  }, [plans, navState?.activePlanId, wtPath]);

  useEffect(() => {
    if (!activePlan) {
      setMarkdown(null);
      return;
    }
    if (activePlan.content) {
      setMarkdown(activePlan.content);
    } else {
      readTextFile(activePlan.plan_path)
        .then((content) => setMarkdown(content))
        .catch(() => setMarkdown(null));
    }
  }, [activePlan?.id, activePlan?.plan_path, activePlan?.content]);

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

  const annotatedLines = useMemo(
    () => new Set(planAnnotations.map((a) => a.line_number)),
    [planAnnotations]
  );

  if (!activePlan) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
        {plans.length > 0 ? (
          <div className="w-full max-w-md">
            <div className="text-sm font-medium text-foreground mb-3">Plans</div>
            <div className="flex flex-col gap-1">
              {plans.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    useUIStore.getState().updateWorktreeNavState(wtPath, {
                      activePlanId: p.id,
                    });
                  }}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-left hover:bg-accent text-sm"
                >
                  <span className="text-foreground truncate">
                    {p.title ?? p.plan_path.split("/").pop()}
                  </span>
                  <span className={`ml-auto text-xs px-1.5 py-0.5 rounded ${
                    p.status === "approved"
                      ? "bg-green-800/30 text-green-400"
                      : p.status === "changes_requested"
                      ? "bg-amber-800/30 text-amber-400"
                      : "bg-blue-800/30 text-blue-400"
                  }`}>
                    {p.status === "changes_requested" ? "changes requested" : p.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-sm">No plans yet</div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenDirectory}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-border text-foreground hover:bg-accent"
          >
            Open Plan Directory
          </button>
          <button
            onClick={handleOpenFile}
            className="px-3 py-1.5 text-sm font-medium rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            Open File
          </button>
        </div>
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
        versions={planVersions}
        onApprove={handleApprove}
        onRequestChanges={handleRequestChanges}
        onClose={handleClose}
        onOpenFile={handleOpenFile}
        onOpenDirectory={handleOpenDirectory}
        onSelectVersion={handleSelectVersion}
      />
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-4xl mx-auto py-6">
          {lines.map((line, index) => {
            const lineNumber = index + 1;
            const hasAnnotation = annotatedLines.has(lineNumber);

            return (
              <div key={lineNumber} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 24px" }}>
                <div
                  className="flex group"
                  data-plan-line={lineNumber}
                >
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
                  <div className="flex-1 min-w-0 px-4 py-0.5">
                    <pre className="text-sm text-foreground font-mono whitespace-pre-wrap break-words m-0 p-0 bg-transparent">
                      {line || "\u00A0"}
                    </pre>
                  </div>
                </div>
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
