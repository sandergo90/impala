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
    background: "#ffffff",
    foreground: "#1f2328",
    primary: "#005FB8",
    border: "#d0d7de",
    accent: "#f0f2f5",
  },
  terminal: {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#1f2328",
    selectionBackground: "rgba(0, 95, 184, 0.15)",
    black: "#1f2328",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#bf8700",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};

export const monokai: Theme = {
  id: "monokai",
  name: "Monokai",
  type: "dark",
  ui: {
    background: "#272822",
    foreground: "#f8f8f2",
    primary: "#A6E22E",
    border: "#3e3d32",
    accent: "#3e3d32",
  },
  terminal: {
    background: "#272822",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    selectionBackground: "#75715E80",
    black: "#333333",
    red: "#f92672",
    green: "#A6E22E",
    yellow: "#e2e22e",
    blue: "#819aff",
    magenta: "#AE81FF",
    cyan: "#66D9EF",
    white: "#e3e3dd",
    brightBlack: "#666666",
    brightRed: "#f92672",
    brightGreen: "#A6E22E",
    brightYellow: "#e2e22e",
    brightBlue: "#819aff",
    brightMagenta: "#AE81FF",
    brightCyan: "#66D9EF",
    brightWhite: "#f8f8f2",
  },
};

export const builtInThemes: Theme[] = [defaultDark, defaultLight, monokai];

export function getBuiltInTheme(id: string): Theme | undefined {
  return builtInThemes.find((t) => t.id === id);
}
