import type { Theme } from "../themes/types";

interface ThemeCardProps {
  theme: Theme;
  isActive: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}

export function ThemeCard({ theme, isActive, onSelect, onDelete }: ThemeCardProps) {
  const { ui } = theme;

  return (
    <button
      onClick={onSelect}
      className="text-left rounded-lg overflow-hidden transition-all"
      style={{
        border: isActive ? "2px solid var(--primary)" : "1px solid var(--border)",
        width: 172,
      }}
    >
      {/* Mini UI preview */}
      <div style={{ display: "flex", height: 80, background: ui.background }}>
        {/* Sidebar */}
        <div style={{ width: 28, background: ui.accent, padding: 4 }}>
          <div style={{ width: "100%", height: 5, background: ui.border, borderRadius: 2, marginBottom: 3 }} />
          <div style={{ width: "100%", height: 5, background: ui.primary, borderRadius: 2, marginBottom: 3 }} />
          <div style={{ width: "100%", height: 5, background: ui.border, borderRadius: 2 }} />
        </div>
        {/* Main content */}
        <div style={{ flex: 1, padding: 4 }}>
          <div style={{ height: 3, background: ui.border, borderRadius: 1, width: "70%", marginBottom: 3 }} />
          <div style={{ display: "flex", gap: 2, flex: 1 }}>
            {/* Diff area */}
            <div style={{ flex: 1, background: ui.accent, borderRadius: 2, padding: 3 }}>
              <div style={{ height: 2, borderRadius: 1, width: "30%", marginBottom: 2, background: theme.terminal.red }} />
              <div style={{ height: 2, background: ui.border, borderRadius: 1, width: "60%", marginBottom: 2 }} />
              <div style={{ height: 2, borderRadius: 1, width: "40%", background: theme.terminal.green }} />
            </div>
            {/* Commit panel */}
            <div style={{ width: 36, background: ui.accent, borderRadius: 2, padding: 3 }}>
              <div style={{ height: 2, background: ui.border, borderRadius: 1, width: "80%", marginBottom: 2 }} />
              <div style={{ height: 2, background: ui.border, borderRadius: 1, width: "50%" }} />
            </div>
          </div>
        </div>
      </div>
      {/* Label */}
      <div
        className="group/card"
        style={{
          padding: "6px 8px",
          background: ui.background,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ color: ui.foreground, fontSize: 11, fontWeight: 500 }}>{theme.name}</span>
        {isActive && !onDelete && (
          <svg width="14" height="14" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="6" stroke="var(--primary)" strokeWidth="1.5" fill="none" />
            <circle cx="8" cy="8" r="3.5" fill="var(--primary)" />
          </svg>
        )}
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="opacity-0 group-hover/card:opacity-100 transition-opacity"
            style={{ color: ui.foreground, fontSize: 11, lineHeight: 1 }}
            title="Delete theme"
          >
            ×
          </button>
        )}
      </div>
    </button>
  );
}
