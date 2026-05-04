import { useDebouncedSetting } from "../../hooks/useDebouncedSetting";

export function AgentIntegrationPane() {
  const [claudeFlags, setClaudeFlags] = useDebouncedSetting("claudeFlags", "global");
  const [codexFlags, setCodexFlags] = useDebouncedSetting("codexFlags", "global");

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Agent flags</h2>
        <p className="text-sm text-muted-foreground">
          Default CLI flags passed when launching each agent. Each project can override these.
          The agent itself is chosen per-worktree when you create it.
        </p>
      </div>

      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <h3 className="text-sm font-medium">Claude Flags</h3>
        <p className="text-md text-muted-foreground">
          CLI flags passed to <code className="font-mono text-foreground">claude</code> on launch.
        </p>
        <input
          type="text"
          value={claudeFlags}
          onChange={(e) => setClaudeFlags(e.target.value)}
          placeholder="--dangerously-skip-permissions"
          className="w-full px-3 py-1.5 border rounded text-sm bg-background font-mono"
        />
      </div>

      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <h3 className="text-sm font-medium">Codex Flags</h3>
        <p className="text-md text-muted-foreground">
          CLI flags passed to <code className="font-mono text-foreground">codex</code> on launch.
        </p>
        <input
          type="text"
          value={codexFlags}
          onChange={(e) => setCodexFlags(e.target.value)}
          placeholder="--yolo"
          className="w-full px-3 py-1.5 border rounded text-sm bg-background font-mono"
        />
      </div>
    </div>
  );
}
