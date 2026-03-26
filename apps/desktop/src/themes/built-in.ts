import type { Theme } from "./types";

export const defaultDark: Theme = {
  id: "default-dark",
  name: "Default Dark",
  type: "dark",
  ui: {
    background: "#181818",
    foreground: "#E4E4E4",
    primary: "#81A1C1",
    border: "#E4E4E413",
    accent: "#242424",
  },
  terminal: {
    background: "#141414",
    foreground: "#E4E4E4",
    cursor: "#E4E4E4",
    selectionBackground: "#E4E4E41E",
    black: "#242424",
    red: "#FC6B83",
    green: "#3FA266",
    yellow: "#D2943E",
    blue: "#81A1C1",
    magenta: "#B48EAD",
    cyan: "#88C0D0",
    white: "#E4E4E4",
    brightBlack: "#E4E4E442",
    brightRed: "#FC6B83",
    brightGreen: "#70B489",
    brightYellow: "#F1B467",
    brightBlue: "#87A6C4",
    brightMagenta: "#B48EAD",
    brightCyan: "#88C0D0",
    brightWhite: "#E4E4E4",
  },
};

export const defaultLight: Theme = {
  id: "default-light",
  name: "Default Light",
  type: "light",
  ui: {
    background: "oklch(1 0 0)",
    foreground: "oklch(0.145 0 0)",
    primary: "oklch(0.205 0 0)",
    border: "oklch(0.922 0 0)",
    accent: "oklch(0.97 0 0)",
  },
  terminal: {
    background: "#ffffff",
    foreground: "#1e1e1e",
    cursor: "#1e1e1e",
    selectionBackground: "rgba(0, 0, 0, 0.15)",
    black: "#1e1e1e",
    red: "#d73a49",
    green: "#28a745",
    yellow: "#dbab09",
    blue: "#0366d6",
    magenta: "#5a32a3",
    cyan: "#0598bc",
    white: "#d1d5da",
    brightBlack: "#6a737d",
    brightRed: "#cb2431",
    brightGreen: "#22863a",
    brightYellow: "#b08800",
    brightBlue: "#005cc5",
    brightMagenta: "#5a32a3",
    brightCyan: "#3192aa",
    brightWhite: "#fafbfc",
  },
};

export const builtInThemes: Theme[] = [defaultDark, defaultLight];

export function getBuiltInTheme(id: string): Theme | undefined {
  return builtInThemes.find((t) => t.id === id);
}
