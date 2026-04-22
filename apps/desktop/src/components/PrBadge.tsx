import { open as openUrl } from "@tauri-apps/plugin-shell";
import { PreviewCard } from "@base-ui/react/preview-card";
import {
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  GitMerge,
} from "lucide-react";
import type { PrStatus } from "../types";
import { PrHoverCard } from "./PrHoverCard";

export function PrBadge({ status }: { status: PrStatus }) {
  if (status.kind !== "has_pr") return null;

  const { Icon, colorClass } = pickVisual(status);

  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger
        delay={200}
        render={
          <span
            onClick={(e) => {
              e.stopPropagation();
              openUrl(status.url);
            }}
            className={`inline-flex items-center gap-0.5 font-mono cursor-pointer hover:underline ${colorClass}`}
          >
            <Icon size={11} />#{status.number}
          </span>
        }
      />
      <PreviewCard.Portal>
        <PreviewCard.Positioner sideOffset={6}>
          <PreviewCard.Popup className="outline-none">
            <PrHoverCard pr={status} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

function pickVisual(pr: { state: "open" | "closed" | "merged"; isDraft: boolean }) {
  if (pr.state === "merged") {
    return { Icon: GitMerge, colorClass: "text-purple-400 hover:text-purple-300" };
  }
  if (pr.state === "closed") {
    return { Icon: GitPullRequestClosed, colorClass: "text-red-400 hover:text-red-300" };
  }
  if (pr.isDraft) {
    return {
      Icon: GitPullRequestDraft,
      colorClass: "text-muted-foreground hover:text-foreground",
    };
  }
  return { Icon: GitPullRequest, colorClass: "text-green-500 hover:text-green-400" };
}
