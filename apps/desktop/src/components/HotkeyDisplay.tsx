import { formatHotkeyParts } from "../lib/hotkeys";
import type { HotkeyId } from "../lib/hotkeys";
import { useHotkeysStore } from "../stores/hotkeys";

export function HotkeyDisplay({
  id,
  className = "",
}: {
  id: HotkeyId;
  className?: string;
}) {
  const effective = useHotkeysStore((s) => s.getEffective(id));
  useHotkeysStore((s) => s.overrides);

  if (!effective) return null;

  const parts = formatHotkeyParts(effective);

  return (
    <span className={`font-mono text-xs ${className}`}>
      {parts.map((part, i) => (
        <kbd key={i} className="min-w-[0.75rem] text-center inline-block">
          {part}
        </kbd>
      ))}
    </span>
  );
}

export function useHotkeyTooltip(id: HotkeyId, label: string): string {
  const effective = useHotkeysStore((s) => s.getEffective(id));
  useHotkeysStore((s) => s.overrides);
  if (!effective) return label;
  const parts = formatHotkeyParts(effective);
  return `${label} (${parts.join("")})`;
}
