import { useState } from "react";
import { CommitPanel } from "./CommitPanel";
import { AnnotationsPanel } from "./AnnotationsPanel";

type Tab = "changes" | "annotations";

export function RightSidebar() {
  const [activeTab, setActiveTab] = useState<Tab>("changes");

  const tabPill = (label: string, tab: Tab) => (
    <button
      onClick={() => setActiveTab(tab)}
      className={`px-2.5 py-1 text-[11px] font-medium rounded-[5px] transition-colors ${
        activeTab === tab
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
      style={activeTab === tab ? { background: "var(--accent)" } : undefined}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        {tabPill("Changes", "changes")}
        {tabPill("Annotations", "annotations")}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {activeTab === "changes" ? <CommitPanel /> : <AnnotationsPanel />}
      </div>
    </div>
  );
}
