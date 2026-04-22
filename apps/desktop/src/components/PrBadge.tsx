import { open as openUrl } from "@tauri-apps/plugin-shell";
import { PreviewCard } from "@base-ui/react/preview-card";
import type { PrStatus } from "../types";
import { PrHoverCard } from "./PrHoverCard";

export function PrBadge({ status }: { status: PrStatus }) {
  if (status.kind !== "has_pr") return null;

  const { colorClass, dotClass, label } = pickVisual(status);

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
            className={`inline-flex items-center gap-1 font-mono text-[10px] rounded px-1.5 py-0.5 cursor-pointer ${colorClass}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            #{status.number} {label}
          </span>
        }
      />
      <PreviewCard.Portal>
        <PreviewCard.Positioner sideOffset={6}>
          <PreviewCard.Popup className="w-80 p-3 rounded-lg border border-border/80 bg-popover shadow-2xl shadow-black/60 ring-1 ring-white/5 text-sm outline-none">
            <PrHoverCard pr={status} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

function pickVisual(pr: { state: "open" | "closed" | "merged"; isDraft: boolean }) {
  if (pr.state === "merged") {
    return {
      colorClass: "bg-purple-500/15 text-purple-400 hover:text-purple-300",
      dotClass: "bg-purple-400",
      label: "merged",
    };
  }
  if (pr.state === "closed") {
    return {
      colorClass: "bg-red-500/15 text-red-400 hover:text-red-300",
      dotClass: "bg-red-400",
      label: "closed",
    };
  }
  if (pr.isDraft) {
    return {
      colorClass: "bg-accent/60 text-muted-foreground hover:text-foreground",
      dotClass: "bg-muted-foreground",
      label: "draft",
    };
  }
  return {
    colorClass: "bg-green-500/15 text-green-500 hover:text-green-400",
    dotClass: "bg-green-500",
    label: "open",
  };
}
