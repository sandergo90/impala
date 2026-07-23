import { open as openUrl } from "@tauri-apps/plugin-shell";
import type { ChecksStatus, PrInfo, ReviewDecision } from "../types";

export function PrHoverCard({ pr }: { pr: PrInfo }) {
  const effectiveState = pr.isDraft && pr.state === "open" ? "draft" : pr.state;
  const providerName = pr.url.includes("bitbucket.org") ? "Bitbucket" : "GitHub";

  return (
    <>
      <div className="flex items-center gap-2 mb-1.5">
        <StatePill state={effectiveState} />
        <span className="font-mono text-xs text-muted-foreground truncate">
          #{pr.number} · {pr.headBranch}
        </span>
      </div>
      <p className="text-foreground font-medium leading-snug mb-3 line-clamp-2">
        {pr.title}
      </p>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground mb-3">
        {pr.checks.total > 0 && pr.checks.status && (
          <div className="flex items-center gap-1.5">
            <ChecksDot status={pr.checks.status} />
            <span>
              {pr.checks.passing}/{pr.checks.total} checks{" "}
              {pr.checks.status === "success"
                ? "passing"
                : pr.checks.status === "failure"
                  ? "failing"
                  : "running"}
            </span>
          </div>
        )}
        {pr.reviewDecision && <div>{reviewLabel(pr.reviewDecision)}</div>}
        {(pr.additions > 0 || pr.deletions > 0) && (
          <div className="font-mono">
            <span className="text-success">+{pr.additions}</span>{" "}
            <span className="text-danger">-{pr.deletions}</span>
          </div>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          openUrl(pr.url);
        }}
        className="w-full text-xs font-medium px-2.5 py-1.5 rounded bg-accent hover:bg-accent/80 text-foreground transition-colors"
      >
        View on {providerName}
      </button>
    </>
  );
}

function StatePill({
  state,
}: {
  state: "open" | "closed" | "merged" | "draft";
}) {
  // Neutral chip, hue on the label only — see PrBadge's pickVisual.
  const cls = {
    open: "text-success",
    draft: "text-muted-foreground",
    merged: "text-info",
    closed: "text-danger",
  }[state];
  const label = state[0].toUpperCase() + state.slice(1);
  return (
    <span
      className={`text-xs font-medium uppercase tracking-wide px-1.5 py-0.5 rounded border border-border bg-accent/60 ${cls}`}
    >
      {label}
    </span>
  );
}

function ChecksDot({ status }: { status: ChecksStatus }) {
  const cls = {
    success: "bg-success",
    failure: "bg-danger",
    pending: "bg-warning animate-pulse",
  }[status];
  return <span className={`w-1.5 h-1.5 rounded-full ${cls}`} />;
}

function reviewLabel(r: ReviewDecision) {
  if (r === "approved") return <span className="text-success">Approved</span>;
  if (r === "changes_requested")
    return <span className="text-danger">Changes requested</span>;
  return <span className="text-muted-foreground">Review requested</span>;
}
