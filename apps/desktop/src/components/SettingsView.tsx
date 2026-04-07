import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AppearancePane } from "./settings/AppearancePane";
import { ClaudeIntegrationPane } from "./settings/ClaudeIntegrationPane";
import { LinearPane } from "./settings/LinearPane";

const navItems = [
  { id: "appearance", label: "Appearance", enabled: true },
  { id: "claude", label: "Claude Integration", enabled: true },
  { id: "linear", label: "Linear", enabled: true },
  { id: "general", label: "General", enabled: false },
  { id: "editor", label: "Editor", enabled: false },
  { id: "keyboard", label: "Keyboard", enabled: false },
  { id: "terminal", label: "Terminal", enabled: false },
];

export function SettingsView() {
  const navigate = useNavigate();
  const [selectedPane, setSelectedPane] = useState("appearance");

  return (
    <div className="flex h-full">
      <div className="w-[200px] border-r border-border/50 py-4 flex flex-col shrink-0">
        <button
          onClick={() => navigate({ to: "/" })}
          className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 2L4 8l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>

        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => item.enabled && setSelectedPane(item.id)}
            disabled={!item.enabled}
            className={`px-4 py-1.5 text-xs text-left w-full rounded-md mx-0 ${
              item.enabled && item.id === selectedPane
                ? "text-foreground font-medium bg-primary/15"
                : item.enabled
                  ? "text-muted-foreground hover:text-foreground"
                  : "text-muted-foreground/50 cursor-not-allowed"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        {selectedPane === "appearance" && <AppearancePane />}
        {selectedPane === "claude" && <ClaudeIntegrationPane />}
        {selectedPane === "linear" && <LinearPane />}
      </div>
    </div>
  );
}
