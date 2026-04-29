import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDebouncedSetting } from "../../hooks/useDebouncedSetting";
import type { Agent } from "../../lib/agent";

export function AgentIntegrationPane() {
  const [agent, setAgent] = useState<Agent>("claude");
  const [claudeFlags, setClaudeFlags] = useDebouncedSetting("claudeFlags", "global");
  const [codexFlags, setCodexFlags] = useDebouncedSetting("codexFlags", "global");

  useEffect(() => {
    invoke<string | null>("get_setting", {
      key: "selectedAgent",
      scope: "global",
    }).then((v) => {
      if (v === "claude" || v === "codex") setAgent(v);
    });
  }, []);

  const handleAgentChange = (next: Agent) => {
    setAgent(next);
    invoke("set_setting", {
      key: "selectedAgent",
      scope: "global",
      value: next,
    }).catch(console.error);
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Agent</h2>
        <p className="text-sm text-muted-foreground">
          Default agent for new worktrees. Each project and worktree can override this.
          Impala writes per-worktree config (no changes to your global ~/.claude or ~/.codex).
        </p>
      </div>

      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <h3 className="text-sm font-medium">Default Agent</h3>
        <div className="flex gap-3">
          {(["claude", "codex"] as const).map((a) => (
            <button
              key={a}
              onClick={() => handleAgentChange(a)}
              className={`px-4 py-2 rounded border text-sm ${
                agent === a
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {a === "claude" ? "Claude Code" : "OpenAI Codex"}
            </button>
          ))}
        </div>
      </div>

      {agent === "claude" ? (
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
      ) : (
        <div className="p-4 rounded-lg border border-border bg-card space-y-3">
          <h3 className="text-sm font-medium">Codex Flags</h3>
          <p className="text-md text-muted-foreground">
            CLI flags passed to <code className="font-mono text-foreground">codex</code> on launch.
          </p>
          <input
            type="text"
            value={codexFlags}
            onChange={(e) => setCodexFlags(e.target.value)}
            placeholder="--sandbox workspace-write"
            className="w-full px-3 py-1.5 border rounded text-sm bg-background font-mono"
          />
        </div>
      )}
    </div>
  );
}
