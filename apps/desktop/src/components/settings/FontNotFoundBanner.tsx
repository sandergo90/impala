import { useEffect, useMemo, useState } from "react";
import { GENERIC_FAMILIES, parsePrimaryFamily } from "../../lib/font-utils";
import { knownSystemFonts } from "../../hooks/useSystemFonts";

function isFontInstalled(family: string): boolean {
  if (GENERIC_FAMILIES.has(family.toLowerCase())) return true;

  // Trust the system font enumeration (NSFontManager on macOS) — canvas
  // measurement can produce false negatives in WebKit.
  if (knownSystemFonts.has(family)) return true;

  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return true;

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
  } catch {
    return true;
  }
}

export function FontNotFoundBanner({ fontFamily }: { fontFamily: string }) {
  const primaryFont = useMemo(
    () => parsePrimaryFamily(fontFamily),
    [fontFamily],
  );

  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!primaryFont) {
      setAvailable(true);
      return;
    }

    setAvailable(null);

    const raf = requestAnimationFrame(() => {
      setAvailable(isFontInstalled(primaryFont));
    });
    return () => cancelAnimationFrame(raf);
  }, [primaryFont]);

  if (available !== false || !primaryFont) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[11px] border-t border-red-500/20 bg-red-500/10 text-red-400">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>
        <strong>{primaryFont}</strong> is not installed on this system. Falling back to the next available font.
      </span>
    </div>
  );
}
