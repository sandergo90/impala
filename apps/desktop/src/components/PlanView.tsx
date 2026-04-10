import { useState, useEffect, useCallback, useMemo } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useUIStore } from "../store";
import { usePlanAnnotationActions } from "../hooks/usePlanAnnotationActions";
import { PlanToolbar } from "./PlanToolbar";
import { PlanAnnotationForm } from "./PlanAnnotationForm";
import { PlanBrowser } from "./PlanBrowser";

export function PlanView() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path ?? "";
  const {
    activePlan,
    plans,
    planAnnotations,
    planVersions,
    handleCreate,
    handleApprove,
    handleRequestChanges,
    handleOpenDiscoveredPlan,
    handleSelectVersion,
  } = usePlanAnnotationActions();

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const lines = useMemo(() => markdown?.split("\n") ?? [], [markdown]);
  const [pendingLine, setPendingLine] = useState<number | null>(null);

  useEffect(() => {
    if (!activePlan) {
      setMarkdown(null);
      setLoadError(false);
      return;
    }
    setLoadError(false);
    if (activePlan.content) {
      setMarkdown(activePlan.content);
    } else {
      setMarkdown(null);
      const path = activePlan.plan_path;
      readTextFile(path)
        .then((content) => setMarkdown(content))
        .catch(() => {
          // Path might be a directory — try overview.md inside it
          if (!path.endsWith(".md")) {
            readTextFile(`${path}/overview.md`)
              .then((content) => setMarkdown(content))
              .catch(() => setLoadError(true));
          } else {
            setLoadError(true);
          }
        });
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
      <PlanBrowser
        plans={plans}
        worktreePath={wtPath}
        onSelectPlan={(planId) => {
          useUIStore.getState().updateWorktreeNavState(wtPath, {
            activePlanId: planId,
          });
        }}
        onOpenDiscoveredPlan={handleOpenDiscoveredPlan}
      />
    );
  }

  if (loadError || markdown === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground text-sm">
        <span>{loadError ? `Could not load ${activePlan.plan_path}` : "Loading plan..."}</span>
        <button
          onClick={() => {
            if (!wtPath) return;
            useUIStore.getState().updateWorktreeNavState(wtPath, {
              activePlanId: null,
            });
          }}
          className="px-3 py-1.5 text-sm font-medium rounded-md border border-border text-foreground hover:bg-accent"
        >
          Back
        </button>
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
