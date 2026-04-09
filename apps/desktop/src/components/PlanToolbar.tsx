import type { Plan } from "../types";

interface PlanToolbarProps {
  plan: Plan;
  onApprove: () => void;
  onRequestChanges: () => void;
  onClose: () => void;
  onOpenFile: () => void;
}

export function PlanToolbar({
  plan,
  onApprove,
  onRequestChanges,
  onClose,
  onOpenFile,
}: PlanToolbarProps) {
  const isPending = plan.status === "pending";
  const title = plan.title ?? plan.plan_path.split("/").pop() ?? "Plan";

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
      <div className="flex-1 min-w-0">
        <span className="text-md font-medium text-foreground truncate">
          {title}
        </span>
        {plan.version > 1 && (
          <span className="ml-2 text-sm text-muted-foreground">
            v{plan.version}
          </span>
        )}
        {!isPending && (
          <span
            className={`ml-2 text-sm px-1.5 py-0.5 rounded ${
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
        onClick={onOpenFile}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
        title="Open markdown file"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 3h5l2 2h5v8H2V3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
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
