import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TabPill } from "./TabPill";
import { markdownComponents } from "./markdownComponents";
import { formatRelativeTime } from "../lib/utils";
import type { Plan } from "../types";

interface DiscoveredPlan {
  path: string;
  title: string;
  is_directory: boolean;
  modified_at: string;
}

interface PlanBrowserProps {
  plans: Plan[];
  worktreePath: string;
  onSelectPlan: (planId: string) => void;
  onOpenDiscoveredPlan: (path: string, title: string) => void;
}

type Tab = "recent" | "browse";

function getFirstLine(content: string | null | undefined): string {
  if (!content) return "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 120);
    }
  }
  return "";
}

function StatusChip({ status }: { status: Plan["status"] }) {
  const cls =
    status === "approved"
      ? "bg-green-800/30 text-green-400"
      : status === "changes_requested"
      ? "bg-amber-800/30 text-amber-400"
      : "bg-blue-800/30 text-blue-400";
  const label = status === "changes_requested" ? "changes requested" : status;
  return (
    <span className={`shrink-0 text-sm px-2 py-0.5 rounded ${cls}`}>
      {label}
    </span>
  );
}

function statusIconColor(status: Plan["status"]): string {
  if (status === "approved") return "text-green-400";
  if (status === "changes_requested") return "text-amber-400";
  return "text-blue-400";
}

export function PlanBrowser({
  plans,
  worktreePath,
  onSelectPlan,
  onOpenDiscoveredPlan,
}: PlanBrowserProps) {
  const [activeTab, setActiveTab] = useState<Tab>(plans.length > 0 ? "recent" : "browse");
  const [discovered, setDiscovered] = useState<DiscoveredPlan[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selectedPlanPath, setSelectedPlanPath] = useState<string | null>(null);
  const [contentCache, setContentCache] = useState<Map<string, string>>(new Map());
  const [annotationCounts, setAnnotationCounts] = useState<Map<string, number>>(new Map());
  const [fileCounts, setFileCounts] = useState<Map<string, number>>(new Map());

  const knownPlanPaths = useMemo(() => {
    const map = new Map<string, Plan>();
    for (const p of plans) map.set(p.plan_path, p);
    return map;
  }, [plans]);

  // Scan for discovered plans
  useEffect(() => {
    if (!worktreePath) return;

    invoke("watch_plan_directories", { worktreePath }).catch(() => {});

    setScanning(true);
    invoke<DiscoveredPlan[]>("scan_plan_directories", { worktreePath })
      .then(setDiscovered)
      .catch(() => {})
      .finally(() => setScanning(false));

    const unlisten = listen<string>("plan-directories-changed", (event) => {
      if (event.payload === worktreePath) {
        invoke<DiscoveredPlan[]>("scan_plan_directories", { worktreePath })
          .then(setDiscovered)
          .catch(() => {});
      }
    });

    return () => {
      unlisten.then((fn) => fn());
      invoke("unwatch_plan_directories", { worktreePath }).catch(() => {});
    };
  }, [worktreePath]);

  // Load content for all plans lazily into a cache
  useEffect(() => {
    plans.forEach((p) => {
      if (contentCache.has(p.plan_path)) return;
      if (p.content) {
        setContentCache((prev) => new Map(prev).set(p.plan_path, p.content!));
      } else {
        invoke<string>("read_plan_file", { path: p.plan_path })
          .then((content) => {
            setContentCache((prev) => new Map(prev).set(p.plan_path, content));
          })
          .catch(() => {});
      }
    });
  }, [plans]);

  // Also load content for discovered plans
  useEffect(() => {
    discovered.forEach((d) => {
      if (contentCache.has(d.path)) return;
      invoke<string>("read_plan_file", { path: d.path })
        .then((content) => {
          setContentCache((prev) => new Map(prev).set(d.path, content));
        })
        .catch(() => {});
    });
  }, [discovered]);

  // Fetch annotation counts for all known plans
  useEffect(() => {
    plans.forEach((p) => {
      invoke<any[]>("list_plan_annotations", {
        planPath: p.plan_path,
        worktreePath: worktreePath || null,
      })
        .then((anns) => {
          setAnnotationCounts((prev) => {
            if (prev.get(p.plan_path) === anns.length) return prev;
            return new Map(prev).set(p.plan_path, anns.length);
          });
        })
        .catch(() => {});
    });
  }, [plans, worktreePath]);

  // Fetch file counts for all known plans
  useEffect(() => {
    plans.forEach((p) => {
      invoke<string[]>("list_plan_files", { path: p.plan_path })
        .then((files) => {
          const count = files.length;
          setFileCounts((prev) => {
            if (prev.get(p.plan_path) === count) return prev;
            return new Map(prev).set(p.plan_path, count);
          });
        })
        .catch(() => {});
    });
  }, [plans]);

  const handleOpenPlan = useCallback(
    (planPath: string) => {
      const knownPlan = knownPlanPaths.get(planPath);
      if (knownPlan) {
        onSelectPlan(knownPlan.id);
      } else {
        const disc = discovered.find((d) => d.path === planPath);
        if (disc) {
          onOpenDiscoveredPlan(disc.path, disc.title);
        }
      }
    },
    [knownPlanPaths, discovered, onSelectPlan, onOpenDiscoveredPlan]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && selectedPlanPath) {
        handleOpenPlan(selectedPlanPath);
      }
    },
    [selectedPlanPath, handleOpenPlan]
  );

  const previewContent = selectedPlanPath ? contentCache.get(selectedPlanPath) : undefined;

  // Find title for selected plan
  const selectedTitle = useMemo(() => {
    if (!selectedPlanPath) return "";
    const known = knownPlanPaths.get(selectedPlanPath);
    if (known?.title) return known.title;
    const disc = discovered.find((d) => d.path === selectedPlanPath);
    if (disc) return disc.title;
    return selectedPlanPath.split("/").pop() ?? "";
  }, [selectedPlanPath, knownPlanPaths, discovered]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        <TabPill label="Recent" isActive={activeTab === "recent"} onClick={() => setActiveTab("recent")} />
        <TabPill label="Browse" isActive={activeTab === "browse"} onClick={() => setActiveTab("browse")} />
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left pane: list */}
        <div
          className="w-[45%] border-r border-border overflow-y-auto min-h-0 outline-none"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          {activeTab === "recent" ? (
            plans.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                No plans reviewed yet
              </div>
            ) : (
              <div className="flex flex-col gap-0.5 p-1.5">
                {plans.map((p) => {
                  const isSelected = selectedPlanPath === p.plan_path;
                  const desc = getFirstLine(contentCache.get(p.plan_path));
                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelectedPlanPath(p.plan_path)}
                      onDoubleClick={() => onSelectPlan(p.id)}
                      className={`flex items-start gap-2.5 px-3 py-2 rounded-md text-left text-base transition-colors ${
                        isSelected ? "bg-accent" : "hover:bg-accent/50"
                      }`}
                    >
                      <svg
                        className={`w-4 h-4 mt-0.5 shrink-0 ${statusIconColor(p.status)}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                        />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground truncate flex-1 font-medium">
                            {p.title ?? p.plan_path.split("/").pop()}
                          </span>
                          <StatusChip status={p.status} />
                          {(annotationCounts.get(p.plan_path) ?? 0) > 0 && (
                            <span className="text-sm px-2 py-0.5 rounded bg-muted text-muted-foreground flex items-center gap-1">
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                              </svg>
                              {annotationCounts.get(p.plan_path)}
                            </span>
                          )}
                          {(fileCounts.get(p.plan_path) ?? 0) > 1 && (
                            <span className="text-sm px-2 py-0.5 rounded bg-muted text-muted-foreground">
                              {fileCounts.get(p.plan_path)} files
                            </span>
                          )}
                        </div>
                        {desc && (
                          <p className="text-muted-foreground text-sm mt-0.5 truncate">
                            {desc}
                          </p>
                        )}
                        <p className="text-muted-foreground/60 text-sm mt-0.5">
                          {formatRelativeTime(p.updated_at)}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )
          ) : scanning ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Scanning...
            </div>
          ) : discovered.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              No plans found in .claude/plans/ or docs/plans/
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 p-1.5">
              {discovered.map((d) => {
                const knownPlan = knownPlanPaths.get(d.path);
                const isSelected = selectedPlanPath === d.path;
                const desc = getFirstLine(contentCache.get(d.path));
                const status = knownPlan?.status;
                return (
                  <button
                    key={d.path}
                    onClick={() => setSelectedPlanPath(d.path)}
                    onDoubleClick={() => {
                      if (knownPlan) {
                        onSelectPlan(knownPlan.id);
                      } else {
                        onOpenDiscoveredPlan(d.path, d.title);
                      }
                    }}
                    className={`flex items-start gap-2.5 px-3 py-2 rounded-md text-left text-base transition-colors ${
                      isSelected ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    <svg
                      className={`w-4 h-4 mt-0.5 shrink-0 ${status ? statusIconColor(status) : "text-muted-foreground"}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                      />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground truncate flex-1 font-medium">
                          {d.title}
                        </span>
                        {status && <StatusChip status={status} />}
                        {knownPlan && (annotationCounts.get(d.path) ?? 0) > 0 && (
                          <span className="text-sm px-2 py-0.5 rounded bg-muted text-muted-foreground flex items-center gap-1">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                            </svg>
                            {annotationCounts.get(d.path)}
                          </span>
                        )}
                        {knownPlan && (fileCounts.get(d.path) ?? 0) > 1 && (
                          <span className="text-sm px-2 py-0.5 rounded bg-muted text-muted-foreground">
                            {fileCounts.get(d.path)} files
                          </span>
                        )}
                      </div>
                      {desc && (
                        <p className="text-muted-foreground text-sm mt-0.5 truncate">
                          {desc}
                        </p>
                      )}
                      <p className="text-muted-foreground/60 text-sm mt-0.5">
                        {formatRelativeTime(d.modified_at)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right pane: preview */}
        <div className="w-[55%] flex flex-col min-h-0">
          {selectedPlanPath ? (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
                <span className="text-sm font-medium text-foreground truncate flex-1">
                  {selectedTitle}
                </span>
                <button
                  onClick={() => handleOpenPlan(selectedPlanPath)}
                  className="px-3 py-1 text-sm font-medium rounded-md border border-border text-foreground hover:bg-accent"
                >
                  Open
                </button>
              </div>
              <div className="plan-markdown flex-1 overflow-y-auto min-h-0 select-text">
                {previewContent ? (
                  <article className="max-w-3xl mx-auto px-6 py-4">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {previewContent}
                    </ReactMarkdown>
                  </article>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    Loading...
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Select a plan to preview
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
