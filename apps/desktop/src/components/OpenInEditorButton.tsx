import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import { useUIStore } from "../store";

import cursorIcon from "../assets/app-icons/cursor.svg";
import vscodeIcon from "../assets/app-icons/vscode.svg";
import zedIcon from "../assets/app-icons/zed.png";
import webstormIcon from "../assets/app-icons/webstorm.svg";
import sublimeIcon from "../assets/app-icons/sublime.svg";

const EDITORS = [
  { id: "cursor", label: "Cursor", icon: cursorIcon },
  { id: "vscode", label: "VS Code", icon: vscodeIcon },
  { id: "zed", label: "Zed", icon: zedIcon },
  { id: "webstorm", label: "WebStorm", icon: webstormIcon },
  { id: "sublime", label: "Sublime Text", icon: sublimeIcon },
] as const;

export function OpenInEditorButton({
  worktreePath,
  filePath,
  tooltip,
}: {
  worktreePath: string;
  filePath?: string;
  tooltip?: string;
}) {
  const [loading, setLoading] = useState(false);
  const preferredEditor = useUIStore((s) => s.preferredEditor);
  const setPreferredEditor = useUIStore((s) => s.setPreferredEditor);

  const current = EDITORS.find((e) => e.id === preferredEditor) ?? EDITORS[0];

  const handleOpen = async (editorId: string) => {
    setLoading(true);
    try {
      const target = filePath ? `${worktreePath}/${filePath}` : worktreePath;
      await invoke("open_in_editor", { editor: editorId, path: target, line: null, col: null });
      if (editorId !== preferredEditor) {
        setPreferredEditor(editorId);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center">
      <button
        onClick={() => handleOpen(current.id)}
        disabled={loading}
        title={tooltip}
        className="flex items-center gap-1.5 h-6 pl-1.5 pr-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-l border border-r-0 border-border/60 bg-secondary/50 hover:bg-secondary hover:border-border disabled:opacity-50 transition-all duration-150"
      >
        <img src={current.icon} alt="" width={14} height={14} className="shrink-0" />
        <span>{loading ? "Opening..." : `Open`}</span>
      </button>
      <Menu.Root>
        <Menu.Trigger
          aria-label="Choose editor"
          className="flex items-center justify-center h-6 w-6 text-muted-foreground hover:text-foreground rounded-r border border-border/60 bg-secondary/50 hover:bg-secondary hover:border-border transition-all duration-150"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="start" className="z-50">
            <Menu.Popup
              className={[
                "bg-popover text-popover-foreground border border-border rounded-md shadow-lg",
                "py-1 min-w-[160px] text-sm outline-none",
                "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
                "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              ].join(" ")}
            >
              {/* `bg-accent` is identical to `bg-popover` in Default Dark, so the
                  highlight derives off the foreground instead (same as
                  ui/context-menu.tsx) — keyboard navigation needs it visible. */}
              {EDITORS.map((editor) => (
                <Menu.Item
                  key={editor.id}
                  onClick={() => handleOpen(editor.id)}
                  className="px-3 py-1.5 cursor-pointer select-none outline-none flex items-center gap-2 data-highlighted:bg-foreground/10"
                >
                  <img src={editor.icon} alt="" width={16} height={16} className="shrink-0" />
                  <span className={editor.id === current.id ? "text-foreground font-medium" : "text-muted-foreground"}>
                    {editor.label}
                  </span>
                  {editor.id === current.id && (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="ml-auto text-foreground">
                      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
