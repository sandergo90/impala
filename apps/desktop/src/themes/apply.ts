import { registerCustomTheme } from "@pierre/diffs";
import type { DiffsThemeNames } from "@pierre/diffs/react";
import type { CSSProperties } from "react";
import type { Theme, ResolvedCSS } from "./types";
import { getBuiltInTheme, defaultDark } from "./built-in";

// ---------------------------------------------------------------------------
// Pierre diff theme registration (follows Superset's pattern)
// ---------------------------------------------------------------------------

const REGISTERED_DIFF_THEMES = new Set<string>();

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function createDiffThemeName(theme: Theme): DiffsThemeNames {
  const sig = hashString(JSON.stringify(theme.terminal) + theme.ui.background + theme.ui.foreground);
  return `differ-${theme.id}-${sig}` as DiffsThemeNames;
}

/**
 * Map terminal ANSI colors to syntax token scopes.
 * Mapping follows superset.sh's convention (getEditorTheme):
 *   keyword→magenta, function→blue, string→green, number→yellow,
 *   type→cyan, constant→cyan, tag→red, comment→brightBlack
 */
function createShikiTheme(theme: Theme) {
  const t = theme.terminal;
  const isDark = theme.type === "dark";
  return {
    name: createDiffThemeName(theme),
    type: theme.type,
    colors: {
      "editor.background": theme.terminal.background,
      "editor.foreground": theme.terminal.foreground,
    },
    tokenColors: [
      { settings: { foreground: theme.ui.foreground, background: theme.ui.background } },
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: t.brightBlack, fontStyle: "italic" } },
      { scope: ["keyword", "storage", "storage.type", "storage.modifier"], settings: { foreground: t.magenta } },
      { scope: ["string", "string.template", "string.quoted"], settings: { foreground: t.green } },
      { scope: ["constant.numeric", "constant.language"], settings: { foreground: t.yellow } },
      { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: t.blue } },
      { scope: ["variable", "meta.definition.variable"], settings: { foreground: theme.ui.foreground } },
      { scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: t.cyan } },
      { scope: ["entity.name.class", "entity.other.inherited-class"], settings: { foreground: t.yellow } },
      { scope: ["variable.other.constant", "constant", "support.constant"], settings: { foreground: t.cyan } },
      { scope: ["string.regexp", "constant.other.character-class.regexp"], settings: { foreground: t.red } },
      { scope: ["entity.name.tag", "punctuation.definition.tag"], settings: { foreground: t.red } },
      { scope: ["entity.other.attribute-name"], settings: { foreground: t.yellow } },
      { scope: ["invalid", "invalid.illegal"], settings: { foreground: isDark ? t.brightRed : t.red } },
    ],
  };
}

/** Get (or register) a Pierre diff theme for the given Differ theme. */
export function getDiffsTheme(theme: Theme): DiffsThemeNames {
  const name = createDiffThemeName(theme);
  if (!REGISTERED_DIFF_THEMES.has(name)) {
    registerCustomTheme(name, async () => createShikiTheme(theme));
    REGISTERED_DIFF_THEMES.add(name);
  }
  return name;
}

/** CSS variable overrides for Pierre diff styling, applied as inline styles on the container. */
export function getDiffViewerStyle(theme: Theme): CSSProperties {
  const isDark = theme.type === "dark";
  const additionColor = isDark ? theme.terminal.brightGreen : theme.terminal.green;
  const deletionColor = isDark ? theme.terminal.brightRed : theme.terminal.red;
  // Pierre's --diffs-bg uses light-dark(var(--diffs-light-bg), var(--diffs-dark-bg))
  // so we must set the inner variables for the active mode.
  return {
    // Set both light and dark variants so light-dark() works regardless of system color-scheme
    "--diffs-dark": theme.terminal.foreground,
    "--diffs-dark-bg": theme.terminal.background,
    "--diffs-light": theme.terminal.foreground,
    "--diffs-light-bg": theme.terminal.background,
    "--diffs-bg-buffer-override": theme.terminal.background,
    "--diffs-bg-hover-override": theme.terminal.background,
    "--diffs-bg-context-override": theme.terminal.background,
    "--diffs-bg-separator-override": theme.ui.border,
    "--diffs-fg-number-override": isDark ? theme.terminal.brightBlack : theme.terminal.white,
    "--diffs-addition-color-override": additionColor,
    "--diffs-deletion-color-override": deletionColor,
    "--diffs-selection-color-override": theme.terminal.selectionBackground,
    backgroundColor: theme.terminal.background,
    color: theme.terminal.foreground,
  } as CSSProperties;
}

// ---------------------------------------------------------------------------
// App-wide theme application (CSS variables for Tailwind / app chrome)
// ---------------------------------------------------------------------------

export function resolveTheme(theme: Theme): ResolvedCSS {
  const { background, foreground, primary, border, accent } = theme.ui;
  const isDark = theme.type === "dark";
  const mix = (color: string, pct: number, base: string = background) =>
    `color-mix(in lab, ${color} ${pct}%, ${base})`;

  return {
    background,
    foreground,
    card: isDark ? mix("#ffffff", 4) : mix("#000000", 3),
    cardForeground: foreground,
    popover: isDark ? mix("#ffffff", 6) : mix("#000000", 4),
    popoverForeground: foreground,
    primary,
    primaryForeground: isDark ? "#191c22" : "#ffffff",
    secondary: accent,
    secondaryForeground: foreground,
    muted: accent,
    mutedForeground: mix(foreground, isDark ? 55 : 45),
    accent,
    accentForeground: foreground,
    destructive: isDark ? "#FC6B83" : "#cf222e",
    border,
    input: border,
    ring: mix(foreground, 35),
    chart1: mix(foreground, 85),
    chart2: mix(foreground, 55),
    chart3: mix(foreground, 45),
    chart4: mix(foreground, 35),
    chart5: mix(foreground, 25),
    sidebar: isDark ? mix(background, 80, "#000000") : accent,
    sidebarForeground: foreground,
    sidebarPrimary: primary,
    sidebarPrimaryForeground: "#ffffff",
    sidebarAccent: accent,
    sidebarAccentForeground: foreground,
    sidebarBorder: border,
    sidebarRing: mix(foreground, 35),
  };
}

/** Map from ResolvedCSS keys to CSS custom property names */
const CSS_VAR_MAP: Record<keyof ResolvedCSS, string> = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  border: "--border",
  input: "--input",
  ring: "--ring",
  chart1: "--chart-1",
  chart2: "--chart-2",
  chart3: "--chart-3",
  chart4: "--chart-4",
  chart5: "--chart-5",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarPrimary: "--sidebar-primary",
  sidebarPrimaryForeground: "--sidebar-primary-foreground",
  sidebarAccent: "--sidebar-accent",
  sidebarAccentForeground: "--sidebar-accent-foreground",
  sidebarBorder: "--sidebar-border",
  sidebarRing: "--sidebar-ring",
};

export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;

  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    root.style.setProperty(cssVar, resolved[key as keyof ResolvedCSS]);
  }

  root.setAttribute("data-theme-type", theme.type);
  root.style.colorScheme = theme.type;
  root.classList.remove("dark");
}

/** Resolve a theme by ID, checking built-ins then custom themes, falling back to defaultDark */
export function resolveThemeById(id: string, customThemes: Theme[]): Theme {
  return getBuiltInTheme(id) ?? customThemes.find((t) => t.id === id) ?? defaultDark;
}

export function initThemeFromStore(activeThemeId: string, customThemes: Theme[]): void {
  applyTheme(resolveThemeById(activeThemeId, customThemes));
}
