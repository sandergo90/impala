import { useState, useEffect, useRef, useCallback } from "react";

interface PlanAnnotationFormProps {
  anchorEl: HTMLElement;
  contextText: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

export function PlanAnnotationForm({
  anchorEl,
  contextText,
  onSubmit,
  onCancel,
}: PlanAnnotationFormProps) {
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  const updatePosition = useCallback(() => {
    const rect = anchorEl.getBoundingClientRect();
    const formHeight = formRef.current?.offsetHeight ?? 200;
    const spaceBelow = window.innerHeight - rect.bottom;
    const showBelow = spaceBelow > formHeight + 8;

    setPosition({
      top: showBelow ? rect.bottom + 4 : rect.top - formHeight - 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 360)),
    });
  }, [anchorEl]);

  useEffect(() => {
    updatePosition();
    textareaRef.current?.focus();
  }, [updatePosition]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <div
      ref={formRef}
      className="plan-comment-popover fixed z-50"
      style={{ top: position.top, left: position.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <form
        onSubmit={handleSubmit}
        className="w-[340px] p-3 rounded-lg border border-border bg-card shadow-lg"
      >
        <div className="text-xs text-muted-foreground mb-2 truncate font-mono">
          &quot;{contextText}&quot;
        </div>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Leave a comment..."
          rows={3}
          className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:border-muted-foreground/50 placeholder:text-muted-foreground/90"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="flex items-center gap-3 mt-2">
          <button
            type="submit"
            disabled={!body.trim()}
            className="px-3.5 py-1.5 text-sm font-medium rounded-md border border-border bg-card text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Comment
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
