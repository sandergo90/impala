import { useState, useEffect, useRef } from "react";

interface InlineAnnotationFormProps {
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

export function InlineAnnotationForm({ onSubmit, onCancel }: InlineAnnotationFormProps) {
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-4 my-3 p-4 rounded-lg border border-border bg-card"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex gap-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 8a3 3 0 100-6 3 3 0 000 6zM2 14a6 6 0 0112 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className="text-muted-foreground"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Leave a comment"
            rows={3}
            className="w-full px-3 py-2 text-xs rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:border-muted-foreground/50 placeholder:text-muted-foreground/50"
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
          <div className="flex items-center gap-3 mt-3">
            <button
              type="submit"
              disabled={!body.trim()}
              className="px-3.5 py-1.5 text-xs font-medium rounded-md border border-border bg-card text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Comment
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
