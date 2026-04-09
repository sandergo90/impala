import { useUIStore } from "../../store";
import { resolveThemeById } from "../../themes/apply";
import { FontNotFoundBanner } from "./FontNotFoundBanner";

const CODE_PREVIEW = `import { createWorktree } from "./git";

export async function setup(branch: string) {
  const wt = await createWorktree({ branch });
  console.log(\`Ready: \${wt.path}\`);
  return wt;
}`;

const TERMINAL_PREVIEW = `\u256D\u2500 impala \u2500\u2500 feat/add-fonts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E
\u2502 \u2713 Created worktree for branch              \u2502
\u2502 \u2713 Installed dependencies                    \u2502
\u2502 \u2BFF Running tests...                           \u2502
\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F

 2 worktrees \u00B7 5 files changed \u00B7 all tests passing`;

export function FontPreview({
  fontFamily,
  fontSize,
  variant,
  isCustomFont,
}: {
  fontFamily: string;
  fontSize: number;
  variant: "editor" | "terminal";
  isCustomFont: boolean;
}) {
  const activeTheme = useUIStore((s) =>
    resolveThemeById(s.activeThemeId, s.customThemes),
  );
  const isTerminal = variant === "terminal";

  return (
    <div
      className="rounded-md border border-border overflow-hidden"
      style={{ backgroundColor: activeTheme.terminal.background }}
    >
      <div
        className="p-3 overflow-x-auto"
        style={{
          fontFamily: fontFamily || undefined,
          fontSize: `${fontSize}px`,
          lineHeight: 1.5,
          whiteSpace: "pre",
          color: activeTheme.terminal.foreground,
        }}
      >
        {isTerminal ? TERMINAL_PREVIEW : CODE_PREVIEW}
      </div>
      {isCustomFont && <FontNotFoundBanner fontFamily={fontFamily} />}
    </div>
  );
}
