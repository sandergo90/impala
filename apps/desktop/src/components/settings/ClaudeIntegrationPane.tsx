import { useDebouncedSetting } from "../../hooks/useDebouncedSetting";

export function ClaudeIntegrationPane() {
  const [flags, handleFlagsChange] = useDebouncedSetting("claudeFlags", "global");

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Claude Integration</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Impala writes per-worktree Claude config (settings.json + .mcp.json) when you open a worktree. Your global ~/.claude config is not modified.
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
      </div>
    </div>
  );
}
