import type { Theme, ResolvedCSS } from "./types";
import { getBuiltInTheme, defaultDark } from "./built-in";

export function resolveTheme(theme: Theme): ResolvedCSS {
  const { background, foreground, primary, border, accent } = theme.ui;
  const isDark = theme.type === "dark";
  const mix = (color: string, pct: number, base: string = background) =>
    `color-mix(in lab, ${color} ${pct}%, ${base})`;

  return {
    background,
    foreground,
    card: background,
    cardForeground: foreground,
    popover: background,
    popoverForeground: foreground,
    primary,
    primaryForeground: isDark ? "#191c22" : "#ffffff",
    secondary: accent,
    secondaryForeground: foreground,
    muted: accent,
    mutedForeground: mix(foreground, isDark ? 55 : 45),
    accent,
    accentForeground: foreground,
    destructive: isDark ? "#FC6B83" : "#E34671",
    border,
    input: border,
    ring: mix(foreground, 35),
    chart1: mix(foreground, 85),
    chart2: mix(foreground, 55),
    chart3: mix(foreground, 45),
    chart4: mix(foreground, 35),
    chart5: mix(foreground, 25),
    sidebar: mix(background, 80, isDark ? "#000000" : "#ffffff"),
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

/** Derive Pierre diff CSS variable overrides from theme colors */
function getDiffOverrides(theme: Theme): Record<string, string> {
  const { background, foreground } = theme.ui;
  const { green, red } = theme.terminal;
  const isDark = theme.type === "dark";

  // Pierre uses --diffs-dark-* / --diffs-light-* as base theme variables.
  // These are the source from which it derives all diff backgrounds/colors.
  const prefix = isDark ? "--diffs-dark" : "--diffs-light";

  return {
    [`${prefix}`]: foreground,
    [`${prefix}-bg`]: background,
    [`${prefix}-addition-color`]: green,
    [`${prefix}-deletion-color`]: red,
  };
}

export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;

  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    root.style.setProperty(cssVar, resolved[key as keyof ResolvedCSS]);
  }

  for (const [cssVar, value] of Object.entries(getDiffOverrides(theme))) {
    root.style.setProperty(cssVar, value);
  }

  root.setAttribute("data-theme-type", theme.type);
  root.classList.remove("dark");
}

/** Resolve a theme by ID, checking built-ins then custom themes, falling back to defaultDark */
export function resolveThemeById(id: string, customThemes: Theme[]): Theme {
  return getBuiltInTheme(id) ?? customThemes.find((t) => t.id === id) ?? defaultDark;
}

export function initThemeFromStore(activeThemeId: string, customThemes: Theme[]): void {
  applyTheme(resolveThemeById(activeThemeId, customThemes));
}
