import { useProsemarkEditor } from "./use-prosemark-editor";
import "./prosemark-theme.css";

interface ProseMarkEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  filePath: string;
  worktreePath: string;
  autoFocus?: boolean;
  className?: string;
}

export function ProseMarkEditor({
  value,
  onChange,
  onSave,
  filePath,
  worktreePath,
  autoFocus,
  className,
}: ProseMarkEditorProps) {
  const editorRef = useProsemarkEditor({
    value,
    onChange,
    onSave,
    filePath,
    worktreePath,
    autoFocus,
  });
  return <div ref={editorRef} className={className} />;
}
