import { useEffect, useState } from "react";
import { CommitPanel } from "./CommitPanel";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { FilesPanel } from "./FilesPanel";
import { TabPill } from "./TabPill";
import { useUIStore } from "../store";

type Tab = "files" | "changes" | "annotations";

export function RightSidebar() {
  const [activeTab, setActiveTab] = useState<Tab>("changes");

  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path ?? "";

  // "Reveal in Files" flips this sidebar to the Files tab. Watching the nonce
  // means re-revealing the same path also forces a switch.
  const pendingReveal = useUIStore((s) => s.pendingTreeReveal);
  useEffect(() => {
    if (!pendingReveal) return;
    if (wtPath && pendingReveal.worktreePath !== wtPath) return;
    setActiveTab("files");
  }, [pendingReveal?.nonce, pendingReveal?.worktreePath, wtPath]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-sidebar">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        <TabPill label="Changes" isActive={activeTab === "changes"} onClick={() => setActiveTab("changes")} />
        <TabPill label="Annotations" isActive={activeTab === "annotations"} onClick={() => setActiveTab("annotations")} />
        <TabPill label="Files" isActive={activeTab === "files"} onClick={() => setActiveTab("files")} />
      </div>
      <div className="flex-1 min-h-0">
        {activeTab === "files" ? <FilesPanel /> : activeTab === "changes" ? <CommitPanel /> : <AnnotationsPanel />}
      </div>
    </div>
  );
}
