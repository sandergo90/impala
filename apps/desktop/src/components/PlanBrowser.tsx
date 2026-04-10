import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TabPill } from "./TabPill";
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

export function PlanBrowser({
  plans,
  worktreePath,
  onSelectPlan,
  onOpenDiscoveredPlan,
}: PlanBrowserProps) {
  const [activeTab, setActiveTab] = useState<Tab>(plans.length > 0 ? "recent" : "browse");
  const [discovered, setDiscovered] = useState<DiscoveredPlan[]>([]);
  const [scanning, setScanning] = useState(false);

  const knownPlanPaths = useMemo(() => {
    const map = new Map<string, Plan>();
    for (const p of plans) map.set(p.plan_path, p);
    return map;
  }, [plans]);

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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        <TabPill label="Recent" isActive={activeTab === "recent"} onClick={() => setActiveTab("recent")} />
        <TabPill label="Browse" isActive={activeTab === "browse"} onClick={() => setActiveTab("browse")} />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === "recent" ? (
          plans.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              No plans reviewed yet
            </div>
          ) : (
            <div className="flex flex-col gap-1 p-2">
              {plans.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onSelectPlan(p.id)}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-left hover:bg-accent text-sm"
                >
                  <span className="text-foreground truncate flex-1">
                    {p.title ?? p.plan_path.split("/").pop()}
                  </span>
                  <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${
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
          <div className="flex flex-col gap-1 p-2">
            {discovered.map((d) => {
              const knownPlan = knownPlanPaths.get(d.path);
              return (
                <button
                  key={d.path}
                  onClick={() => {
                    if (knownPlan) {
                      onSelectPlan(knownPlan.id);
                    } else {
                      onOpenDiscoveredPlan(d.path, d.title);
                    }
                  }}
                  className="flex items-center gap-2 px-3 py-2 rounded-md text-left hover:bg-accent text-sm"
                >
                  <span className="text-foreground truncate flex-1">{d.title}</span>
                  {knownPlan ? (
                    <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${
                      knownPlan.status === "approved"
                        ? "bg-green-800/30 text-green-400"
                        : knownPlan.status === "changes_requested"
                        ? "bg-amber-800/30 text-amber-400"
                        : "bg-blue-800/30 text-blue-400"
                    }`}>
                      {knownPlan.status === "changes_requested" ? "changes" : knownPlan.status}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelativeTime(d.modified_at)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
