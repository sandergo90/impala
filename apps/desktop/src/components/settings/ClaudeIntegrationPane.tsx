import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

export function ClaudeIntegrationPane() {
  const [setting, setSetting] = useState(false);

  async function handleSetup() {
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
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold mb-1">Claude Integration</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Connect Canopy to Claude Code so Claude can read and resolve your code review annotations.
      </p>

      <div className="space-y-4">
        <div className="p-4 rounded-lg border border-border bg-card">
          <h3 className="text-sm font-medium mb-2">MCP Server</h3>
          <p className="text-md text-muted-foreground mb-3">
            The Canopy MCP server gives Claude access to your annotations.
            Click below to add it to your Claude Code settings.
          </p>
          <button
            onClick={handleSetup}
            disabled={setting}
            className="px-4 py-2 text-md rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {setting ? "Configuring..." : "Setup Claude Integration"}
          </button>
        </div>

        <div className="p-4 rounded-lg border border-border bg-card">
          <h3 className="text-sm font-medium mb-2">Available Tools</h3>
          <p className="text-md text-muted-foreground mb-2">
            Once configured, Claude can use these tools:
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
      </div>
    </div>
  );
}
