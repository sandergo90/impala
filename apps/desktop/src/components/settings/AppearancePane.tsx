import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { useUIStore } from "../../store";
import { builtInThemes } from "../../themes/built-in";
import { parseThemeJSON, generateTemplate } from "../../themes/import";
import { ThemeCard } from "../ThemeCard";

const darkThemes = builtInThemes.filter((t) => t.type === "dark");
const lightThemes = builtInThemes.filter((t) => t.type === "light");

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

export function AppearancePane() {
  const activeThemeId = useUIStore((s) => s.activeThemeId);
  const setActiveThemeId = useUIStore((s) => s.setActiveThemeId);
  const customThemes = useUIStore((s) => s.customThemes);
  const addCustomTheme = useUIStore((s) => s.addCustomTheme);
  const removeCustomTheme = useUIStore((s) => s.removeCustomTheme);
  const fontSize = useUIStore((s) => s.fontSize);
  const setFontSize = useUIStore((s) => s.setFontSize);

  const handleImport = async () => {
    const path = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });
    if (!path) return;

    try {
      const json = await readTextFile(path as string);
      const existingIds = new Set(customThemes.map((t) => t.id));
      const result = parseThemeJSON(json, existingIds);

      if (result.errors.length > 0) {
        toast.error(result.errors.join("\n"));
      }
      if (result.themes.length > 0) {
        for (const theme of result.themes) {
          addCustomTheme(theme);
        }
        toast.success(`Imported ${result.themes.length} theme${result.themes.length > 1 ? "s" : ""}`);
      } else if (result.errors.length === 0) {
        toast.error("No valid themes found in file");
      }
    } catch (e) {
      toast.error("Failed to read theme file");
    }
  };

  const handleDownloadTemplate = async () => {
    const path = await save({
      defaultPath: "canopy-theme-template.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;

    try {
      await writeTextFile(path, generateTemplate());
      toast.success("Template saved");
    } catch {
      toast.error("Failed to save template");
    }
  };

  return (
    <div>
      <h2 className="text-base font-semibold text-foreground">Appearance</h2>
      <p className="text-md text-muted-foreground mt-1 mb-6">Customize the look and feel of Canopy</p>

      {/* Dark themes */}
      <div className="text-md font-semibold uppercase tracking-wider text-muted-foreground mb-3">Dark</div>
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
      <div className="text-md font-semibold uppercase tracking-wider text-muted-foreground mb-3">Light</div>
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

      {/* Custom themes */}
      <div className="text-md font-semibold uppercase tracking-wider text-muted-foreground mb-3">Custom Themes</div>
      <div className="flex flex-wrap gap-3 mb-4">
        {customThemes.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            isActive={activeThemeId === theme.id}
            onSelect={() => setActiveThemeId(theme.id)}
            onDelete={() => removeCustomTheme(theme.id)}
          />
        ))}

        {/* Import button */}
        <button
          onClick={handleImport}
          className="flex flex-col items-center justify-center gap-1.5 rounded-lg transition-colors hover:bg-accent/50"
          style={{
            width: 172,
            height: 108,
            border: "1px dashed var(--border)",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-md text-muted-foreground">Import Theme</span>
        </button>
      </div>

      {/* Download template link */}
      <button
        onClick={handleDownloadTemplate}
        className="text-md text-muted-foreground underline hover:text-foreground transition-colors"
      >
        Download template
      </button>
      <span className="text-md text-muted-foreground/50 ml-2">JSON file with all tokens</span>

      {/* Font size */}
      <div className="text-md font-semibold uppercase tracking-wider text-muted-foreground mt-8 mb-3">Font Size</div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setFontSize(Math.max(MIN_FONT_SIZE, fontSize - 1))}
          disabled={fontSize <= MIN_FONT_SIZE}
          className="flex items-center justify-center w-7 h-7 rounded-md border border-border bg-background text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-medium"
        >
          −
        </button>
        <span className="text-sm text-foreground tabular-nums w-8 text-center">{fontSize}px</span>
        <button
          onClick={() => setFontSize(Math.min(MAX_FONT_SIZE, fontSize + 1))}
          disabled={fontSize >= MAX_FONT_SIZE}
          className="flex items-center justify-center w-7 h-7 rounded-md border border-border bg-background text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-medium"
        >
          +
        </button>
      </div>
    </div>
  );
}
