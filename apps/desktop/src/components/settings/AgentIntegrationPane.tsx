import { useDebouncedSetting } from "../../hooks/useDebouncedSetting";
import { CodexDiagnosticsPane } from "./CodexDiagnosticsPane";
import { CodexRemotePane } from "./CodexRemotePane";

export function AgentIntegrationPane() {
  const [claudeFlags, setClaudeFlags] = useDebouncedSetting(
    "claudeFlags",
    "global",
  );
  const [codexFlags, setCodexFlags] = useDebouncedSetting(
    "codexFlags",
    "global",
  );
  const [nativeCodexPanes, setNativeCodexPanes] = useDebouncedSetting(
    "nativeCodexPanes",
    "global",
  );

  return (
    <div className="max-w-2xl space-y-8">
      <section
        aria-labelledby="codex-integration-heading"
        className="space-y-4"
      >
        <div>
          <h3
            id="codex-integration-heading"
            className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Codex
          </h3>
          <p className="text-sm text-muted-foreground">
            Configure Codex launches and access Impala sessions through ChatGPT
            Remote.
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h4 className="text-sm font-medium">Launch flags</h4>
          <p className="text-sm text-muted-foreground">
            CLI flags passed to{" "}
            <code className="font-mono text-foreground">codex</code> on launch.
            Each project can override this default.
          </p>
          <input
            type="text"
            value={codexFlags}
            onChange={(e) => setCodexFlags(e.target.value)}
            placeholder="--yolo"
            aria-label="Default Codex CLI flags"
            className="w-full rounded-sm border bg-background px-3 py-1.5 font-mono text-sm"
          />
        </div>

        <label className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-sm">
          <input
            type="checkbox"
            checked={nativeCodexPanes === "true"}
            onChange={(event) =>
              setNativeCodexPanes(event.target.checked ? "true" : "false")
            }
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium">Use native Codex pane</span>
            <span className="text-muted-foreground">
              Use structured native Codex only when the launch flags can be
              translated exactly. Split and delegated agent panes remain
              terminal-backed.
            </span>
          </span>
        </label>

        <CodexRemotePane />
        <CodexDiagnosticsPane />
      </section>

      <section
        aria-labelledby="claude-integration-heading"
        className="space-y-4"
      >
        <div>
          <h3
            id="claude-integration-heading"
            className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Claude
          </h3>
          <p className="text-sm text-muted-foreground">
            Configure how Impala launches Claude.
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h4 className="text-sm font-medium">Launch flags</h4>
          <p className="text-sm text-muted-foreground">
            CLI flags passed to{" "}
            <code className="font-mono text-foreground">claude</code> on launch.
            Each project can override this default.
          </p>
          <input
            type="text"
            value={claudeFlags}
            onChange={(e) => setClaudeFlags(e.target.value)}
            placeholder="--dangerously-skip-permissions"
            aria-label="Default Claude CLI flags"
            className="w-full rounded-sm border bg-background px-3 py-1.5 font-mono text-sm"
          />
        </div>
      </section>
    </div>
  );
}
