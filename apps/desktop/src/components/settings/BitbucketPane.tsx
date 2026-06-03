import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useInvoke } from "../../hooks/useInvoke";
import type { BitbucketCliStatus } from "../../types";

export function BitbucketPane() {
  const { data: status, loading } = useInvoke<BitbucketCliStatus>(
    "get_bitbucket_cli_status",
  );

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Bitbucket</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Show pull-request status on your worktrees.
      </p>
      <div className="p-4 rounded-lg border border-border bg-card">
        {loading || status === null ? (
          <p className="text-md text-muted-foreground">
            Checking Bitbucket CLI…
          </p>
        ) : (
          <StatusBody status={status} />
        )}
      </div>
    </div>
  );
}

function StatusBody({ status }: { status: BitbucketCliStatus }) {
  if (status.installed && status.authenticated && status.username) {
    const isOauth = status.authMethod === "oauth";
    return (
      <div className="space-y-2">
        <p className="text-md text-foreground">
          Connected as{" "}
          <span className="font-mono text-green-500">@{status.username}</span>{" "}
          via Bitbucket CLI
          {status.authMethod ? ` (${status.authMethod})` : ""}.
        </p>
        {isOauth && (
          <p className="text-sm text-muted-foreground">
            You're signed in with a short-lived OAuth token
            {status.expires ? `, expiring ${status.expires}` : ""}. For
            uninterrupted status, sign in with a year-long API token instead:{" "}
            <code className="font-mono text-foreground">
              bkt auth login bitbucket.org --kind cloud --web-token
            </code>
            .
          </p>
        )}
      </div>
    );
  }

  if (status.installed) {
    return (
      <p className="text-md text-muted-foreground">
        Bitbucket CLI is installed, but you're not logged in. Run{" "}
        <code className="font-mono text-foreground">
          bkt auth login bitbucket.org --kind cloud --web-token
        </code>{" "}
        in your terminal, then reopen this tab.
      </p>
    );
  }

  return (
    <p className="text-md text-muted-foreground">
      Bitbucket CLI (<code className="font-mono text-foreground">bkt</code>) not
      found on your PATH. Install with{" "}
      <code className="font-mono text-foreground">
        brew install avivsinai/tap/bitbucket-cli
      </code>{" "}
      or{" "}
      <button
        onClick={() => openUrl("https://github.com/avivsinai/bitbucket-cli")}
        className="underline underline-offset-2 hover:text-foreground"
      >
        see install options
      </button>
      .
    </p>
  );
}
