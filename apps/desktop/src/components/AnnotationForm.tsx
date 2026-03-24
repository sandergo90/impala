import { useState } from "react";

interface AnnotationFormProps {
  onSubmit: (body: string, lineNumber: number, side: "left" | "right") => void;
  onCancel: () => void;
}

export function AnnotationForm({ onSubmit, onCancel }: AnnotationFormProps) {
  const [body, setBody] = useState("");
  const [lineNumber, setLineNumber] = useState(1);
  const [side, setSide] = useState<"left" | "right">("right");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || lineNumber < 1) return;
    onSubmit(trimmed, lineNumber, side);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 p-3 border rounded-md bg-card"
    >
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground">Line</label>
        <input
          type="number"
          min={1}
          value={lineNumber}
          onChange={(e) => setLineNumber(Number(e.target.value))}
          className="w-20 px-2 py-1 text-xs rounded border bg-background text-foreground"
        />
        <label className="text-xs text-muted-foreground">Side</label>
        <select
          value={side}
          onChange={(e) => setSide(e.target.value as "left" | "right")}
          className="px-2 py-1 text-xs rounded border bg-background text-foreground"
        >
          <option value="left">Left (deletions)</option>
          <option value="right">Right (additions)</option>
        </select>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a comment..."
        rows={3}
        className="px-2 py-1 text-xs rounded border bg-background text-foreground resize-y"
      />
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 text-xs rounded text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!body.trim()}
          className="px-3 py-1 text-xs rounded bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          Add Comment
        </button>
      </div>
    </form>
  );
}
