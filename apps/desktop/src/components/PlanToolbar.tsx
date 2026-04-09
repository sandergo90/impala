import { useState, useRef, useEffect } from "react";
import type { Plan } from "../types";
import { formatRelativeTime } from "../lib/utils";

interface PlanToolbarProps {
  plan: Plan;
  versions: Plan[];
  onApprove: () => void;
  onRequestChanges: () => void;
  onClose: () => void;
  onOpenFile: () => void;
  onOpenDirectory: () => void;
  onSelectVersion: (planId: string) => void;
}

export function PlanToolbar({
  plan,
  versions,
  onApprove,
  onRequestChanges,
  onClose,
  onOpenFile,
  onOpenDirectory,
  onSelectVersion,
}: PlanToolbarProps) {
  const isPending = plan.status === "pending";
  const title = plan.title ?? plan.plan_path.split("/").pop() ?? "Plan";
  const hasMultipleVersions = versions.length > 1;
  const [showVersions, setShowVersions] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showVersions) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowVersions(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showVersions]);

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-md font-medium text-foreground truncate">
          {title}
        </span>
        {hasMultipleVersions ? (
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setShowVersions(!showVersions)}
              className="text-sm text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent"
            >
              v{plan.version} <span className="text-xs">▾</span>
            </button>
            {showVersions && (
              <div className="absolute top-full left-0 mt-1 w-64 bg-card border border-border rounded-md shadow-lg z-50 py-1">
                {versions.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => {
                      onSelectVersion(v.id);
                      setShowVersions(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent ${
                      v.id === plan.id ? "bg-accent/50" : ""
                    }`}
                  >
                    <span className="font-mono text-muted-foreground">v{v.version}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      v.status === "approved"
                        ? "bg-green-800/30 text-green-400"
                        : v.status === "changes_requested"
                        ? "bg-amber-800/30 text-amber-400"
                        : "bg-blue-800/30 text-blue-400"
                    }`}>
                      {v.status === "changes_requested" ? "changes" : v.status}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatRelativeTime(v.created_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : plan.version > 1 ? (
          <span className="text-sm text-muted-foreground">v{plan.version}</span>
        ) : null}
        {!isPending && (
          <span
            className={`text-sm px-1.5 py-0.5 rounded ${
              plan.status === "approved"
                ? "bg-green-800/30 text-green-400"
                : "bg-amber-800/30 text-amber-400"
            }`}
          >
            {plan.status === "approved" ? "Approved" : "Changes Requested"}
          </span>
        )}
      </div>
      {isPending && (
        <div className="flex items-center gap-2">
          <button
            onClick={onRequestChanges}
            className="px-3 py-1.5 text-md font-medium rounded-md border border-border text-foreground hover:bg-accent"
          >
            Request Changes
          </button>
          <button
            onClick={onApprove}
            className="px-3 py-1.5 text-md font-medium rounded-md bg-green-600 text-white hover:bg-green-500"
          >
            Approve
          </button>
        </div>
      )}
      <button
        onClick={onOpenDirectory}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
        title="Open plan directory"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 3h5l2 2h5v8H2V3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
        </svg>
      </button>
      <button
        onClick={onOpenFile}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
        title="Open markdown file"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 2h7l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
          <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
        </svg>
      </button>
      <button
        onClick={onClose}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
        title="Close plan"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
