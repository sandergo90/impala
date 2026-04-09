import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

export function ClaudeIntegrationPane() {
  const [setting, setSetting] = useState(false);
  const [flags, setFlags] = useState("");
  const [flagsLoaded, setFlagsLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    invoke<string | null>("get_setting", { key: "claudeFlags", scope: "global" })
      .then((val) => {
        setFlags(val ?? "");
        setFlagsLoaded(true);
      })
      .catch(() => setFlagsLoaded(true));
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleFlagsChange = (value: string) => {
    setFlags(value);
    if (!flagsLoaded) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        if (value.trim()) {
          await invoke("set_setting", { key: "claudeFlags", scope: "global", value: value.trim() });
        } else {
          await invoke("delete_setting", { key: "claudeFlags", scope: "global" });
        }
      } catch (e) {
        toast.error(`Failed to save claude flags: ${e}`);
      }
    }, 500);
  };

  async function handleReconfigure() {
    setSetting(true);
    try {
      const binaryPath = await invoke<string>("setup_claude_integration");
      toast.success(`Claude integration configured. Binary: ${binaryPath}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSetting(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Claude Integration</h2>
      <p className="text-sm text-muted-foreground mb-6">
        The Impala MCP server is automatically configured when the app starts,
        giving Claude Code access to your code review annotations.
      </p>

      <div className="space-y-4">
        <div className="p-4 rounded-lg border border-border bg-card space-y-3">
          <h3 className="text-sm font-medium">Launch Flags</h3>
          <p className="text-md text-muted-foreground">
            CLI flags passed to <code className="font-mono text-foreground">claude</code> when
            starting a session. Can be overridden per project.
          </p>
          <input
            type="text"
            value={flags}
            onChange={(e) => handleFlagsChange(e.target.value)}
            placeholder="--dangerously-skip-permissions --remote-control"
            className="w-full px-3 py-1.5 border rounded text-sm bg-background font-mono"
          />
        </div>

        <div className="p-4 rounded-lg border border-border bg-card">
          <h3 className="text-sm font-medium mb-2">Available Tools</h3>
          <p className="text-md text-muted-foreground mb-2">
            Claude can use these tools:
          </p>
          <ul className="text-md text-muted-foreground space-y-1">
            <li className="flex items-center gap-2">
              <span className="font-mono text-foreground">list_annotations</span>
              — Read annotations for a file or commit
            </li>
            <li className="flex items-center gap-2">
              <span className="font-mono text-foreground">resolve_annotation</span>
              — Mark an annotation as resolved
            </li>
            <li className="flex items-center gap-2">
              <span className="font-mono text-foreground">list_files_with_annotations</span>
              — Find files with unresolved comments
            </li>
          </ul>
        </div>

        <button
          onClick={handleReconfigure}
          disabled={setting}
          className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          {setting ? "Reconfiguring..." : "Reconfigure manually"}
        </button>
      </div>
    </div>
  );
}
