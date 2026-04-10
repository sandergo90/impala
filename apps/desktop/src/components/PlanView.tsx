import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useUIStore } from "../store";
import { usePlanAnnotationActions } from "../hooks/usePlanAnnotationActions";
import { usePlanHighlighter } from "../hooks/usePlanHighlighter";
import { useSelectedPlanAnnotation } from "../hooks/useSelectedPlanAnnotation";
import { PlanToolbar } from "./PlanToolbar";
import { PlanBrowser } from "./PlanBrowser";
import { PlanAnnotationForm } from "./PlanAnnotationForm";
import type { Components } from "react-markdown";

const markdownComponents: Partial<Components> = {
  code: ({ className, children }) => {
    const isBlock = className?.startsWith("language-");
    if (isBlock) {
      return (
        <code className={className}>
          {children}
        </code>
      );
    }
    return (
      <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-muted/50 border border-border rounded-md p-4 overflow-x-auto my-4 text-sm font-mono">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-4">
      <table className="w-max min-w-full divide-y divide-border">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2 text-left text-sm font-semibold bg-muted align-top">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 text-sm border-t border-border align-top">
      {children}
    </td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-muted-foreground/30 pl-4 italic my-4">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-8 border-border" />,
  li: ({ children, className }) => {
    const isTaskItem = className?.includes("task-list-item");
    return (
      <li className={isTaskItem ? "list-none flex items-start gap-2" : undefined}>
        {children}
      </li>
    );
  },
};

export function PlanView() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path ?? "";
  const {
    activePlan,
    plans,
    planVersions,
    planAnnotations,
    handleCreate,
    handleApprove,
    handleRequestChanges,
    handleOpenDiscoveredPlan,
    handleSelectVersion,
  } = usePlanAnnotationActions();

  const articleRef = useRef<HTMLElement>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useSelectedPlanAnnotation();

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [directoryFiles, setDirectoryFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // Detect if plan is a directory and list its files
  useEffect(() => {
    if (!activePlan) {
      setDirectoryFiles([]);
      setActiveFile(null);
      return;
    }
    invoke<string[]>("list_plan_files", { path: activePlan.plan_path })
      .then((files) => {
        if (files.length > 1) {
          setDirectoryFiles(files);
          setActiveFile(files[0]);
        } else {
          setDirectoryFiles([]);
          setActiveFile(null);
        }
      })
      .catch(() => {
        setDirectoryFiles([]);
        setActiveFile(null);
      });
  }, [activePlan?.id, activePlan?.plan_path]);

  // Load the active file content
  useEffect(() => {
    if (!activePlan) {
      setMarkdown(null);
      setLoadError(false);
      return;
    }
    setLoadError(false);
    if (activePlan.content && !activeFile) {
      setMarkdown(activePlan.content);
    } else {
      setMarkdown(null);
      const pathToRead = activeFile ?? activePlan.plan_path;
      invoke<string>("read_plan_file", { path: pathToRead })
        .then((content) => setMarkdown(content))
        .catch(() => setLoadError(true));
    }
  }, [activePlan?.id, activePlan?.plan_path, activePlan?.content, activeFile]);

  const handleBack = useCallback(() => {
    if (!wtPath) return;
    useUIStore.getState().updateWorktreeNavState(wtPath, {
      activePlanId: null,
    });
  }, [wtPath]);

  useEffect(() => {
    if (!activePlan) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleBack();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activePlan, handleBack]);

  const {
    commentPopover,
    handleCommentSubmit,
    handleCommentClose,
  } = usePlanHighlighter({
    containerRef: articleRef,
    annotations: planAnnotations,
    selectedAnnotationId,
    onSelectAnnotation: setSelectedAnnotationId,
  });

  const handleAnnotationSubmit = useCallback(
    (body: string) => {
      const result = handleCommentSubmit();
      if (result) {
        handleCreate(body, result.originalText, result.highlightSource);
      }
    },
    [handleCommentSubmit, handleCreate]
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
        onClose={handleBack}
        onSelectVersion={handleSelectVersion}
      />
      {directoryFiles.length > 1 && (
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border shrink-0 overflow-x-auto">
          {directoryFiles.map((file) => {
            const name = file.split("/").pop() ?? file;
            const isActive = file === activeFile;
            return (
              <button
                key={file}
                onClick={() => setActiveFile(file)}
                className={`px-2 py-0.5 text-sm font-mono rounded whitespace-nowrap ${
                  isActive
                    ? "text-foreground bg-accent"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
      <div className="plan-markdown flex-1 overflow-y-auto min-h-0 select-text">
        <article ref={articleRef} className="max-w-4xl mx-auto px-8 py-6">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {markdown}
          </ReactMarkdown>
        </article>
      </div>
      {commentPopover && (
        <PlanAnnotationForm
          anchorEl={commentPopover.anchorEl}
          contextText={commentPopover.contextText}
          onSubmit={handleAnnotationSubmit}
          onCancel={handleCommentClose}
        />
      )}
    </div>
  );
}
