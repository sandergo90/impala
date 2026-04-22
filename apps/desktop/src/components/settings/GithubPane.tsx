import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useInvoke } from "../../hooks/useInvoke";
import type { GithubCliStatus } from "../../types";

export function GithubPane() {
  const { data: status, loading } = useInvoke<GithubCliStatus>(
    "get_github_cli_status",
  );

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">GitHub</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Show pull-request status on your worktrees.
      </p>
      <div className="p-4 rounded-lg border border-border bg-card">
        {loading || status === null ? (
          <p className="text-md text-muted-foreground">Checking GitHub CLI…</p>
        ) : (
          <StatusBody status={status} />
        )}
      </div>
    </div>
  );
}

function StatusBody({ status }: { status: GithubCliStatus }) {
  if (status.installed && status.authenticated && status.username) {
    return (
      <p className="text-md text-foreground">
        Connected as{" "}
        <span className="font-mono text-green-500">@{status.username}</span>{" "}
        via GitHub CLI.
      </p>
    );
  }

  if (status.installed) {
    return (
      <p className="text-md text-muted-foreground">
        GitHub CLI is installed, but you're not logged in. Run{" "}
        <code className="font-mono text-foreground">gh auth login</code> in
        your terminal, then reopen this tab.
      </p>
    );
  }

  return (
    <p className="text-md text-muted-foreground">
      GitHub CLI (<code className="font-mono text-foreground">gh</code>) not
      found on your PATH.{" "}
      <button
        onClick={() => openUrl("https://cli.github.com")}
        className="underline underline-offset-2 hover:text-foreground"
      >
        Install from cli.github.com
      </button>
      .
    </p>
  );
}
