import { SettingsView } from "../components/SettingsView";

export function SettingsLayout() {
  return (
    <>
      {/* Title bar — simplified for settings */}
      <div
        className="relative flex items-center h-10 shrink-0 border-b border-border/50 bg-background"
        style={{ paddingLeft: "78px" }}
      >
        <div className="absolute inset-0" data-tauri-drag-region />
        <div
          className="flex-1 flex items-center justify-center text-[11px] text-muted-foreground font-medium"
          data-tauri-drag-region
        >
          Settings
        </div>
      </div>

      <SettingsView />
    </>
  );
}
