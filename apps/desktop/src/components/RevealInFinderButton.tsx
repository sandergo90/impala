import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { Folder } from "lucide-react";
import { toast } from "sonner";
import { dirname } from "../lib/path-utils";

export function RevealInFinderButton({
  worktreePath,
  filePath,
}: {
  worktreePath: string;
  filePath: string;
}) {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    try {
      const dir = dirname(filePath);
      const target = dir ? `${worktreePath}/${dir}` : worktreePath;
      await open(target);
    } catch (e) {
      toast.error(`Failed to reveal: ${e}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title="Reveal in Finder"
      className="flex items-center justify-center h-6 w-6 text-muted-foreground hover:text-foreground rounded border border-border/60 bg-secondary/50 hover:bg-secondary hover:border-border disabled:opacity-50 transition-all duration-150"
    >
      <Folder size={14} />
    </button>
  );
}
