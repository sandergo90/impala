import type { Theme, ThemeUI, ThemeTerminal } from "./types";
import { defaultDark, defaultLight, builtInThemes } from "./built-in";

const BUILT_IN_IDS = new Set(builtInThemes.map((t) => t.id));

function getDefaults(type: "dark" | "light"): { ui: ThemeUI; terminal: ThemeTerminal } {
  const base = type === "dark" ? defaultDark : defaultLight;
  return { ui: { ...base.ui }, terminal: { ...base.terminal } };
}

export interface ImportResult {
  themes: Theme[];
  errors: string[];
}

export function parseThemeJSON(json: string, existingIds: Set<string>): ImportResult {
  const errors: string[] = [];
  const themes: Theme[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { themes: [], errors: ["Invalid JSON"] };
  }

  let rawThemes: unknown[];
  if (Array.isArray(parsed)) {
    rawThemes = parsed;
  } else if (
    typeof parsed === "object" &&
    parsed !== null &&
    "themes" in parsed &&
    Array.isArray((parsed as Record<string, unknown>).themes)
  ) {
    rawThemes = (parsed as Record<string, unknown>).themes as unknown[];
  } else if (typeof parsed === "object" && parsed !== null) {
    rawThemes = [parsed];
  } else {
    return { themes: [], errors: ["Expected a theme object, array, or { themes: [...] }"] };
  }

  for (let i = 0; i < rawThemes.length; i++) {
    const raw = rawThemes[i] as Record<string, unknown>;
    const prefix = rawThemes.length > 1 ? `Theme ${i + 1}: ` : "";

    if (typeof raw.id !== "string" || raw.id.trim() === "") {
      errors.push(`${prefix}"id" is required and must be a non-empty string`);
      continue;
    }
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      errors.push(`${prefix}"name" is required and must be a non-empty string`);
      continue;
    }
    if (raw.type !== "dark" && raw.type !== "light") {
      errors.push(`${prefix}"type" must be "dark" or "light"`);
      continue;
    }

    if (BUILT_IN_IDS.has(raw.id)) {
      errors.push(`${prefix}ID "${raw.id}" conflicts with a built-in theme`);
      continue;
    }
    if (existingIds.has(raw.id)) {
      errors.push(`${prefix}ID "${raw.id}" already exists`);
      continue;
    }

    const defaults = getDefaults(raw.type);

    const rawUI = (typeof raw.ui === "object" && raw.ui !== null ? raw.ui : {}) as Record<string, unknown>;
    const ui: ThemeUI = {
      background: typeof rawUI.background === "string" ? rawUI.background : defaults.ui.background,
      foreground: typeof rawUI.foreground === "string" ? rawUI.foreground : defaults.ui.foreground,
      primary: typeof rawUI.primary === "string" ? rawUI.primary : defaults.ui.primary,
      border: typeof rawUI.border === "string" ? rawUI.border : defaults.ui.border,
      accent: typeof rawUI.accent === "string" ? rawUI.accent : defaults.ui.accent,
    };

    const rawTerm = (typeof raw.terminal === "object" && raw.terminal !== null ? raw.terminal : {}) as Record<string, unknown>;
    const terminal: ThemeTerminal = {} as ThemeTerminal;
    for (const key of Object.keys(defaults.terminal) as (keyof ThemeTerminal)[]) {
      (terminal as unknown as Record<string, string>)[key] =
        typeof rawTerm[key] === "string" ? (rawTerm[key] as string) : defaults.terminal[key];
    }

    themes.push({
      id: raw.id,
      name: raw.name,
      type: raw.type,
      author: typeof raw.author === "string" ? raw.author : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
      ui,
      terminal,
    });

    existingIds.add(raw.id);
  }

  return { themes, errors };
}

export function generateTemplate(): string {
  const template = {
    _comment: "Differ theme file. Edit the values below and import via Settings > Appearance.",
    id: "my-custom-theme",
    name: "My Custom Theme",
    type: "dark",
    author: "",
    description: "",
    _comment_ui: "UI colors — only include the ones you want to override. Missing values fall back to defaults for the theme type.",
    ui: { ...defaultDark.ui },
    _comment_terminal: "Terminal ANSI colors — only include the ones you want to override.",
    terminal: { ...defaultDark.terminal },
  };
  return JSON.stringify(template, null, 2);
}
