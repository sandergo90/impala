import { useUIStore } from "../../store";
import { builtInThemes } from "../../themes/built-in";
import { ThemeCard } from "../ThemeCard";

const darkThemes = builtInThemes.filter((t) => t.type === "dark");
const lightThemes = builtInThemes.filter((t) => t.type === "light");

export function AppearancePane() {
  const activeThemeId = useUIStore((s) => s.activeThemeId);
  const setActiveThemeId = useUIStore((s) => s.setActiveThemeId);

  return (
    <div>
      <h2 className="text-base font-semibold text-foreground">Appearance</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-6">Customize the look and feel of Differ</p>

      {/* Dark themes */}
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Dark</div>
      <div className="flex flex-wrap gap-3 mb-6">
        {darkThemes.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            isActive={activeThemeId === theme.id}
            onSelect={() => setActiveThemeId(theme.id)}
          />
        ))}
      </div>

      {/* Light themes */}
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Light</div>
      <div className="flex flex-wrap gap-3 mb-6">
        {lightThemes.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            isActive={activeThemeId === theme.id}
            onSelect={() => setActiveThemeId(theme.id)}
          />
        ))}
      </div>
    </div>
  );
}
