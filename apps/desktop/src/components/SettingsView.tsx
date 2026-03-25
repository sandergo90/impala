import { useUIStore } from "../store";
import { AppearancePane } from "./settings/AppearancePane";

const navItems = [
  { id: "appearance", label: "Appearance", enabled: true },
  { id: "general", label: "General", enabled: false },
  { id: "editor", label: "Editor", enabled: false },
  { id: "keyboard", label: "Keyboard", enabled: false },
  { id: "terminal", label: "Terminal", enabled: false },
];

export function SettingsView() {
  const setCurrentView = useUIStore((s) => s.setCurrentView);

  return (
    <div className="flex h-full">
      {/* Settings sidebar */}
      <div className="w-[200px] border-r border-border/50 py-4 flex flex-col shrink-0">
        {/* Back button */}
        <button
          onClick={() => setCurrentView("main")}
          className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 2L4 8l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>

        {/* Nav items */}
        {navItems.map((item) => (
          <div
            key={item.id}
            className={`px-4 py-1.5 text-xs ${
              item.enabled
                ? "text-foreground font-medium border-l-2 border-primary"
                : "text-muted-foreground/50 cursor-not-allowed"
            }`}
          >
            {item.label}
          </div>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-8">
        <AppearancePane />
      </div>
    </div>
  );
}
