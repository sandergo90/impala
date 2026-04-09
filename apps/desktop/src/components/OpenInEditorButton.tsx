import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
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

export function OpenInEditorButton({ worktreePath }: { worktreePath: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const preferredEditor = useUIStore((s) => s.preferredEditor);
  const setPreferredEditor = useUIStore((s) => s.setPreferredEditor);

  const current = EDITORS.find((e) => e.id === preferredEditor) ?? EDITORS[0];

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleOpen = async (editorId: string) => {
    setLoading(true);
    setOpen(false);
    try {
      await invoke("open_in_editor", { editor: editorId, path: worktreePath, line: null, col: null });
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
    <div className="relative" ref={ref}>
      <div className="flex items-center">
        <button
          onClick={() => handleOpen(current.id)}
          disabled={loading}
          className="flex items-center gap-1.5 h-6 pl-1.5 pr-2 text-md font-medium text-muted-foreground hover:text-foreground rounded-l border border-r-0 border-border/60 bg-secondary/50 hover:bg-secondary hover:border-border disabled:opacity-50 transition-all duration-150"
        >
          <img src={current.icon} alt="" width={14} height={14} className="shrink-0" />
          <span>{loading ? "Opening..." : `Open`}</span>
        </button>
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center justify-center h-6 w-6 text-muted-foreground hover:text-foreground rounded-r border border-border/60 bg-secondary/50 hover:bg-secondary hover:border-border transition-all duration-150"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[160px] border rounded-md bg-popover shadow-lg py-1">
          {EDITORS.map((editor) => (
            <button
              key={editor.id}
              onClick={() => handleOpen(editor.id)}
              className="w-full px-3 py-1.5 text-left text-md hover:bg-accent flex items-center gap-2"
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
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
