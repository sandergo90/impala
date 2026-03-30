import { useState } from "react";
import { useUIStore } from "../../store";

export function LinearPane() {
  const linearApiKey = useUIStore((s) => s.linearApiKey);
  const setLinearApiKey = useUIStore((s) => s.setLinearApiKey);
  const [inputValue, setInputValue] = useState(linearApiKey);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setLinearApiKey(inputValue.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = () => {
    setInputValue("");
    setLinearApiKey("");
  };

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold mb-1">Linear</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Connect to Linear to create worktrees from issues.
      </p>

      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <h3 className="text-sm font-medium">Personal API Key</h3>
        <p className="text-xs text-muted-foreground">
          Generate a key at{" "}
          <span className="font-mono text-foreground">
            Linear &gt; Settings &gt; API &gt; Personal API keys
          </span>
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setSaved(false);
            }}
            placeholder="lin_api_..."
            className="flex-1 px-3 py-1.5 border rounded text-sm bg-background font-mono"
          />
          <button
            onClick={handleSave}
            disabled={inputValue.trim() === linearApiKey}
            className="px-4 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saved ? "Saved" : "Save"}
          </button>
        </div>
        {linearApiKey && (
          <button
            onClick={handleClear}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            Remove key
          </button>
        )}
      </div>
    </div>
  );
}
