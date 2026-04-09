import { useState } from "react";
import { CommitPanel } from "./CommitPanel";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { TabPill } from "./TabPill";

type Tab = "changes" | "annotations";

export function RightSidebar() {
  const [activeTab, setActiveTab] = useState<Tab>("changes");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        <TabPill label="Changes" isActive={activeTab === "changes"} onClick={() => setActiveTab("changes")} />
        <TabPill label="Annotations" isActive={activeTab === "annotations"} onClick={() => setActiveTab("annotations")} />
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {activeTab === "changes" ? <CommitPanel /> : <AnnotationsPanel />}
      </div>
    </div>
  );
}
