import { useProsemarkEditor } from "./use-prosemark-editor";
import "./prosemark-theme.css";

interface ProseMarkEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  filePath: string;
  worktreePath: string;
  getScrollContainer?: () => HTMLElement | null;
  autoFocus?: boolean;
  className?: string;
}

export function ProseMarkEditor({
  value,
  onChange,
  onSave,
  filePath,
  worktreePath,
  getScrollContainer,
  autoFocus,
  className,
}: ProseMarkEditorProps) {
  const editorRef = useProsemarkEditor({
    value,
    onChange,
    onSave,
    filePath,
    worktreePath,
    getScrollContainer,
    autoFocus,
  });
  return <div ref={editorRef} className={className} />;
}
