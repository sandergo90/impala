import { useState, type ReactNode } from "react";
import { invoke } from "@/lib/invoke";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useUIStore } from "../../store";

type Section<T> = { data?: T; error?: string; truncated: boolean };
type Diagnostics = {
  connection: { status: string; version?: string; error?: string };
  account: Section<{
    accountType?: string;
    email?: string;
    plan?: string;
    requiresOpenaiAuth: boolean;
  }>;
  rateLimits: Section<{
    primaryUsedPercent?: number;
    secondaryUsedPercent?: number;
    resetsAt?: number;
    reached?: string;
  }>;
  models: Section<{
    defaultModel?: string;
    models: Array<{
      id: string;
      efforts: string[];
      tiers: string[];
      modalities: string[];
    }>;
  }>;
  config: Section<{
    model?: string;
    effort?: string;
    serviceTier?: string;
    approvalPolicy?: string;
    sandbox?: string;
  }>;
  mcp: Section<{
    impalaMcpPresent: boolean;
    impalaMcpUnhealthyReason?: string;
    servers: Array<{
      name: string;
      authStatus?: string;
      toolCount: number;
    }>;
  }>;
};

function SectionView({
  title,
  section,
  children,
}: {
  title: string;
  section: Section<unknown>;
  children?: ReactNode;
}) {
  return (
    <div className="rounded border border-border p-3 text-sm">
      <div className="font-medium">{title}</div>
      {section.error ? (
        <p className="mt-1 text-destructive">{section.error}</p>
      ) : (
        children
      )}
      {section.truncated ? (
        <p className="mt-1 text-muted-foreground">
          Results were truncated after the safe page limit. Refresh after
          reducing the catalog.
        </p>
      ) : null}
    </div>
  );
}

export function CodexDiagnosticsPane() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setDiagnostics(
        await invoke<Diagnostics>("get_codex_diagnostics", {
          cwd: useUIStore.getState().selectedProject?.path ?? null,
        }),
      );
      setRefreshError(null);
    } catch (error) {
      setRefreshError(
        `Could not refresh Codex diagnostics. Check that the managed Codex app-server is available. ${String(error)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  useMountEffect(() => {
    void refresh();
  });

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      aria-labelledby="codex-diagnostics-heading"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 id="codex-diagnostics-heading" className="text-sm font-medium">
            Diagnostics
          </h4>
          <p className="text-sm text-muted-foreground">
            Read-only status from the Codex app-server.
          </p>
        </div>
        <button
          type="button"
          className="rounded border border-border px-3 py-1.5 text-sm"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {diagnostics ? (
        <div className="grid gap-2">
          {refreshError ? (
            <p role="alert" className="text-sm text-destructive">
              {refreshError}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Connection: {diagnostics.connection.status}
            {diagnostics.connection.version
              ? ` (${diagnostics.connection.version})`
              : ""}
            {diagnostics.connection.error
              ? ` -- ${diagnostics.connection.error}`
              : ""}
          </p>
          <SectionView title="Account" section={diagnostics.account}>
            {diagnostics.account.data ? (
              <p>
                {diagnostics.account.data.accountType ?? "Unknown"}
                {diagnostics.account.data.email
                  ? ` -- ${diagnostics.account.data.email}`
                  : ""}
                {diagnostics.account.data.plan
                  ? ` (${diagnostics.account.data.plan})`
                  : ""}
                {diagnostics.account.data.requiresOpenaiAuth
                  ? " -- OpenAI sign-in required"
                  : " -- OpenAI sign-in not required"}
              </p>
            ) : null}
          </SectionView>
          <SectionView title="Rate limits" section={diagnostics.rateLimits}>
            {diagnostics.rateLimits.data ? (
              <p>
                Primary:{" "}
                {diagnostics.rateLimits.data.primaryUsedPercent ?? "unknown"}%
                -- Secondary:{" "}
                {diagnostics.rateLimits.data.secondaryUsedPercent ?? "unknown"}%
                {diagnostics.rateLimits.data.reached
                  ? ` -- ${diagnostics.rateLimits.data.reached}`
                  : ""}
                {diagnostics.rateLimits.data.resetsAt
                  ? ` -- resets ${new Date(diagnostics.rateLimits.data.resetsAt * 1000).toLocaleString()}`
                  : ""}
              </p>
            ) : null}
          </SectionView>
          <SectionView title="Models" section={diagnostics.models}>
            {diagnostics.models.data ? (
              <details>
                <summary>
                  Default: {diagnostics.models.data.defaultModel ?? "unknown"};{" "}
                  {diagnostics.models.data.models.length} available.
                </summary>
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {diagnostics.models.data.models.map((model) => (
                    <li key={model.id}>
                      {model.id} -- efforts:{" "}
                      {model.efforts.join(", ") || "none"}; tiers:{" "}
                      {model.tiers.join(", ") || "none"}; input:{" "}
                      {model.modalities.join(", ") || "text"}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </SectionView>
          <SectionView title="Effective settings" section={diagnostics.config}>
            {diagnostics.config.data ? (
              <p>
                {[
                  diagnostics.config.data.model,
                  diagnostics.config.data.effort,
                  diagnostics.config.data.serviceTier,
                  diagnostics.config.data.approvalPolicy,
                  diagnostics.config.data.sandbox,
                ]
                  .filter(Boolean)
                  .join(" -- ") || "No supported setting reported."}
              </p>
            ) : null}
          </SectionView>
          <SectionView title="MCP" section={diagnostics.mcp}>
            {diagnostics.mcp.data ? (
              <div className="space-y-1">
                <p>
                  impala-mcp:{" "}
                  {diagnostics.mcp.data.impalaMcpPresent
                    ? "present"
                    : "missing"}
                  {diagnostics.mcp.data.impalaMcpUnhealthyReason
                    ? ` -- ${diagnostics.mcp.data.impalaMcpUnhealthyReason}`
                    : ""}
                </p>
                <ul className="text-muted-foreground">
                  {diagnostics.mcp.data.servers.map((server) => (
                    <li key={server.name}>
                      {server.name} -- auth: {server.authStatus ?? "unknown"};
                      tools: {server.toolCount}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </SectionView>
        </div>
      ) : (
        <>
          {refreshError ? (
            <p role="alert" className="text-sm text-destructive">
              {refreshError}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {loading ? "Loading diagnostics…" : "Diagnostics are unavailable."}
          </p>
        </>
      )}
    </section>
  );
}
