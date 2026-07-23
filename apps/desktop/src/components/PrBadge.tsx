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
            className={`inline-flex items-center gap-1 font-mono text-xs bg-accent/60 rounded px-1.5 py-0.5 cursor-pointer ${colorClass}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            #{status.number} {label}
          </span>
        }
      />
      <PreviewCard.Portal>
        <PreviewCard.Positioner sideOffset={6}>
          <PreviewCard.Popup className="w-80 p-3 rounded-lg border border-border/80 bg-popover shadow-2xl ring-1 ring-foreground/10 text-sm outline-none">
            <PrHoverCard pr={status} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

// The chip background is always `bg-accent/60` (set on the trigger); state is
// carried by the text + dot token only. A same-hue wash behind same-hue text
// erodes the contrast the status tokens exist to guarantee.
function pickVisual(pr: { state: "open" | "closed" | "merged"; isDraft: boolean }) {
  if (pr.state === "merged") {
    return {
      colorClass: "text-info hover:text-foreground",
      dotClass: "bg-info",
      label: "merged",
    };
  }
  if (pr.state === "closed") {
    return {
      colorClass: "text-danger hover:text-foreground",
      dotClass: "bg-danger",
      label: "closed",
    };
  }
  if (pr.isDraft) {
    return {
      colorClass: "text-muted-foreground hover:text-foreground",
      dotClass: "bg-muted-foreground",
      label: "draft",
    };
  }
  return {
    colorClass: "text-success hover:text-foreground",
    dotClass: "bg-success",
    label: "open",
  };
}
