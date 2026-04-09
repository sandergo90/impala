import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type FontCategory = "nerd" | "mono" | "other";

export interface FontInfo {
  family: string;
  category: FontCategory;
}

const REGISTERED_FONTS: FontInfo[] = navigator.platform.startsWith("Mac")
  ? [{ family: "SF Mono", category: "mono" }]
  : [];

const WELL_KNOWN_NERD: string[] = [
  "MesloLGM Nerd Font",
  "MesloLGS Nerd Font",
  "FiraCode Nerd Font",
  "Hack Nerd Font",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "RobotoMono Nerd Font",
  "UbuntuMono Nerd Font",
  "SourceCodePro Nerd Font",
];

const WELL_KNOWN_MONO: string[] = [
  "Fira Code",
  "JetBrains Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Hack",
  "Source Code Pro",
  "Cascadia Code",
  "Cascadia Mono",
  "IBM Plex Mono",
  "Inconsolata",
  "Roboto Mono",
  "Ubuntu Mono",
  "Victor Mono",
  "Iosevka",
  "Geist Mono",
  "Input Mono",
  "DejaVu Sans Mono",
  "Fira Mono",
  "PT Mono",
  "Noto Sans Mono",
  "Anonymous Pro",
  "Liberation Mono",
  "Droid Sans Mono",
  "Courier New",
];

const KNOWN_MONO_SET = new Set([
  ...WELL_KNOWN_MONO,
  ...WELL_KNOWN_NERD,
  ...REGISTERED_FONTS.map((f) => f.family),
]);

let sharedCtx: CanvasRenderingContext2D | null = null;
function getCanvasCtx(): CanvasRenderingContext2D | null {
  if (!sharedCtx) {
    sharedCtx = document.createElement("canvas").getContext("2d");
  }
  return sharedCtx;
}

function isFontAvailable(family: string): boolean {
  const ctx = getCanvasCtx();
  if (!ctx) return false;

  const testString = "mmmmmmmmmmlli10OQ@#$%";
  const fallbacks = ["monospace", "sans-serif"] as const;

  for (const fallback of fallbacks) {
    ctx.font = `72px ${fallback}`;
    const fallbackWidth = ctx.measureText(testString).width;

    ctx.font = `72px "${family}", ${fallback}`;
    const testWidth = ctx.measureText(testString).width;

    if (Math.abs(testWidth - fallbackWidth) > 0.5) {
      return true;
    }
  }
  return false;
}

function classifyFont(family: string): FontCategory {
  if (/Nerd Font/i.test(family) || / NF$/i.test(family)) {
    return "nerd";
  }
  if (KNOWN_MONO_SET.has(family)) {
    return "mono";
  }
  return "other";
}

function isMonospaceByMeasurement(family: string): boolean {
  const ctx = getCanvasCtx();
  if (!ctx) return false;
  ctx.font = `16px "${family}"`;
  const narrowWidth = ctx.measureText("iiiiii").width;
  const wideWidth = ctx.measureText("MMMMMM").width;
  return Math.abs(narrowWidth - wideWidth) < 1;
}

function discoverWellKnownFonts(): FontInfo[] {
  const result: FontInfo[] = [];
  for (const family of WELL_KNOWN_NERD) {
    if (isFontAvailable(family)) {
      result.push({ family, category: "nerd" });
    }
  }
  for (const family of WELL_KNOWN_MONO) {
    if (isFontAvailable(family)) {
      result.push({ family, category: "mono" });
    }
  }
  return result;
}

let cachedFonts: FontInfo[] | null = null;

/**
 * Set of font family names known to be installed (from system enumeration).
 * Used by FontNotFoundBanner to avoid false positives — canvas measurement
 * can fail for fonts that WebKit can actually render.
 */
export const knownSystemFonts = new Set<string>();

export function useSystemFonts() {
  const [fonts, setFonts] = useState<FontInfo[]>(cachedFonts ?? []);
  const [isLoading, setIsLoading] = useState(cachedFonts === null);

  useEffect(() => {
    if (cachedFonts) return;

    let cancelled = false;

    async function loadFonts() {
      await document.fonts.ready;

      const result: FontInfo[] = [];
      const seen = new Set<string>();

      // Add registered @font-face fonts (e.g. SF Mono on macOS)
      for (const font of REGISTERED_FONTS) {
        if (isFontAvailable(font.family)) {
          result.push(font);
          seen.add(font.family);
        }
      }

      // Add well-known fonts detected via canvas measurement
      for (const font of discoverWellKnownFonts()) {
        if (!seen.has(font.family)) {
          seen.add(font.family);
          result.push(font);
        }
      }

      // Use Tauri backend to enumerate all system fonts. On macOS this uses
      // NSFontManager which returns the exact CSS-compatible family names that
      // WebKit recognises — no canvas validation needed.
      try {
        const systemFamilies = await invoke<string[]>("list_system_fonts");
        for (const family of systemFamilies) {
          if (seen.has(family)) continue;
          seen.add(family);

          let category = classifyFont(family);
          if (category === "other" && isMonospaceByMeasurement(family)) {
            category = "mono";
          }
          result.push({ family, category });
        }
      } catch {
        // Fallback: try Chromium queryLocalFonts if available
        if ("queryLocalFonts" in window) {
          try {
            const fontData = await (window as any).queryLocalFonts();
            for (const fd of fontData) {
              if (seen.has(fd.family)) continue;
              seen.add(fd.family);

              let category = classifyFont(fd.family);
              if (category === "other" && isMonospaceByMeasurement(fd.family)) {
                category = "mono";
              }
              result.push({ family: fd.family, category });
            }
          } catch {
            // Neither method available
          }
        }
      }

      result.sort((a, b) => a.family.localeCompare(b.family));

      for (const font of result) {
        knownSystemFonts.add(font.family);
      }
      cachedFonts = result;
      if (!cancelled) {
        setFonts(result);
        setIsLoading(false);
      }
    }

    loadFonts().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return { fonts, isLoading };
}
