import { useState, useRef, useEffect } from "react";
import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import { useUIStore } from "../../store";
import { Button } from "@/components/ui/button";

export function LinearPane() {
  const linearApiKey = useUIStore((s) => s.linearApiKey);
  const setLinearApiKey = useUIStore((s) => s.setLinearApiKey);
  const [inputValue, setInputValue] = useState(linearApiKey);
  const [saved, setSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handleSave = async () => {
    const trimmed = inputValue.trim();
    try {
      if (trimmed) {
        await invoke("set_setting", { key: "linearApiKey", scope: "global", value: trimmed });
      } else {
        await invoke("delete_setting", { key: "linearApiKey", scope: "global" });
      }
      setLinearApiKey(trimmed);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      toast.error(`Failed to save API key: ${e}`);
    }
  };

  const handleClear = async () => {
    try {
      await invoke("delete_setting", { key: "linearApiKey", scope: "global" });
      setInputValue("");
      setLinearApiKey("");
    } catch (e) {
      toast.error(`Failed to clear API key: ${e}`);
    }
  };

  return (
    <div className="max-w-2xl">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Linear
      </h3>
      <p className="text-sm text-muted-foreground mb-6">
        Connect to Linear to create worktrees from issues.
      </p>

      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <h3 className="text-sm font-medium">Personal API Key</h3>
        <p className="text-sm text-muted-foreground">
          Generate a key at{" "}
          <span className="font-mono text-foreground">
            Linear &gt; Settings &gt; Security &amp; access &gt; Personal API keys
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
          <Button
            onClick={handleSave}
            disabled={inputValue.trim() === linearApiKey}
          >
            {saved ? "Saved" : "Save"}
          </Button>
        </div>
        {linearApiKey && (
          <button
            onClick={handleClear}
            className="text-sm text-muted-foreground hover:text-destructive transition-colors"
          >
            Remove key
          </button>
        )}
      </div>
    </div>
  );
}
