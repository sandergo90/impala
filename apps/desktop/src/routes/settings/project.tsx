import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { projectSettingsRoute } from "../../router";
import { useDataStore } from "../../store";
import { useDebouncedSetting } from "../../hooks/useDebouncedSetting";
import { useInvoke } from "../../hooks/useInvoke";
import type { Agent } from "../../lib/agent";

interface ProjectConfig {
  setup?: string | null;
  run?: string | null;
}

type SaveStatus = "idle" | "saving" | "saved";

export function ProjectSettingsRoute() {
  const { projectId } = projectSettingsRoute.useParams();
  const projectPath = decodeURIComponent(projectId);
  const project = useDataStore((s) =>
    s.projects.find((p) => p.path === projectPath)
  );
  const projectName =
    project?.name ??
    projectPath.split("/").filter(Boolean).pop() ??
    projectPath;

  const [setup, setSetup] = useState("");
  const [run, setRun] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const loadedRef = useRef(false);
  const setupRef = useRef(setup);
  const runRef = useRef(run);
  setupRef.current = setup;
  runRef.current = run;

  const [claudeFlags, handleClaudeFlagsChange] = useDebouncedSetting("claudeFlags", projectPath);
  const [codexFlags, handleCodexFlagsChange] = useDebouncedSetting("codexFlags", projectPath);
  const [agent, setAgent] = useState<Agent | "">("");
  useEffect(() => {
    invoke<string | null>("get_setting", {
      key: "selectedAgent",
      scope: projectPath,
    }).then((v) => {
      setAgent(v === "claude" || v === "codex" ? v : "");
    });
  }, [projectPath]);
  const handleAgentChange = (next: Agent | "") => {
    setAgent(next);
    if (next === "") {
      invoke("delete_setting", { key: "selectedAgent", scope: projectPath }).catch(console.error);
    } else {
      invoke("set_setting", { key: "selectedAgent", scope: projectPath, value: next }).catch(console.error);
    }
  };

  // Reset loaded flag and clean up timers when projectPath changes
  useEffect(() => {
    loadedRef.current = false;
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [projectPath]);

  // Load config on mount / when projectPath changes
  useInvoke<ProjectConfig>("read_project_config", { projectPath }, {
    onSuccess: (config) => {
      setSetup(config.setup ?? "");
      setRun(config.run ?? "");
      loadedRef.current = true;
    },
    onError: (e) => {
      toast.error(`Failed to load project config: ${e}`);
      loadedRef.current = true;
    },
  });

  const saveConfig = useCallback(
    (nextSetup: string, nextRun: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);

      debounceRef.current = setTimeout(async () => {
        setSaveStatus("saving");
        try {
          await invoke("write_project_config", {
            projectPath,
            config: {
              setup: nextSetup.trim() || null,
              run: nextRun.trim() || null,
            },
          });
          setSaveStatus("saved");
          if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
          savedTimerRef.current = setTimeout(
            () => setSaveStatus("idle"),
            2000
          );
        } catch (e) {
          setSaveStatus("idle");
          toast.error(`Failed to save project config: ${e}`);
        }
      }, 500);
    },
    [projectPath]
  );

  const handleSetupChange = (value: string) => {
    setSetup(value);
    if (loadedRef.current) saveConfig(value, runRef.current);
  };

  const handleRunChange = (value: string) => {
    setRun(value);
    if (loadedRef.current) saveConfig(setupRef.current, value);
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{projectName}</h2>
        <p className="text-sm text-muted-foreground mt-1">{projectPath}</p>
      </div>

      <div className="p-4 rounded-lg border border-border bg-card space-y-5">
        <h3 className="text-sm font-medium">Scripts</h3>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Setup</label>
          <p className="text-md text-muted-foreground">
            Runs automatically after creating a new worktree.
          </p>
          <textarea
            value={setup}
            onChange={(e) => handleSetupChange(e.target.value)}
            rows={4}
            className="w-full px-3 py-2 rounded border border-border bg-background font-mono text-sm resize-y"
            placeholder="npm install"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Run</label>
          <p className="text-md text-muted-foreground">
            Start the dev server. Triggered via Cmd+Shift+R.
          </p>
          <textarea
            value={run}
            onChange={(e) => handleRunChange(e.target.value)}
            rows={4}
            className="w-full px-3 py-2 rounded border border-border bg-background font-mono text-sm resize-y"
            placeholder="npm run dev"
          />
        </div>

        <div className="flex justify-end">
          {saveStatus === "saving" && (
            <span className="text-md text-muted-foreground">Saving...</span>
          )}
          {saveStatus === "saved" && (
            <span className="text-md text-muted-foreground">Saved ✓</span>
          )}
        </div>
      </div>

      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <h3 className="text-sm font-medium">Agent</h3>
        <p className="text-md text-muted-foreground">
          Override the default agent for this project. Empty = inherit global default.
        </p>
        <div className="flex gap-2">
          {(["", "claude", "codex"] as const).map((a) => (
            <button
              key={a || "default"}
              onClick={() => handleAgentChange(a)}
              className={`px-3 py-1 rounded border text-sm ${
                agent === a ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"
              }`}
            >
              {a === "" ? "Default" : a === "claude" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <h3 className="text-sm font-medium">Claude Flags</h3>
        <p className="text-md text-muted-foreground">
          CLI flags passed to <code className="font-mono text-foreground">claude</code> when
          starting a session in this project. Leave empty to use the global default.
        </p>
        <input
          type="text"
          value={claudeFlags}
          onChange={(e) => handleClaudeFlagsChange(e.target.value)}
          placeholder="--dangerously-skip-permissions --remote-control"
          className="w-full px-3 py-1.5 border rounded text-sm bg-background font-mono"
        />
      </div>

      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <h3 className="text-sm font-medium">Codex Flags</h3>
        <p className="text-md text-muted-foreground">
          CLI flags passed to <code className="font-mono text-foreground">codex</code> on launch in this project. Leave empty to use the global default.
        </p>
        <input
          type="text"
          value={codexFlags}
          onChange={(e) => handleCodexFlagsChange(e.target.value)}
          placeholder="--sandbox workspace-write"
          className="w-full px-3 py-1.5 border rounded text-sm bg-background font-mono"
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Environment variables</h3>
        <p className="text-md text-muted-foreground">
          These variables are available in your scripts:
        </p>
        <div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
          <div className="flex items-baseline gap-2">
            <code className="text-md font-mono text-foreground">$IMPALA_PROJECT_PATH</code>
            <span className="text-md text-muted-foreground">— Main repository root</span>
          </div>
          <div className="flex items-baseline gap-2">
            <code className="text-md font-mono text-foreground">$IMPALA_WORKTREE_PATH</code>
            <span className="text-md text-muted-foreground">— Worktree directory (also the working directory)</span>
          </div>
          <div className="flex items-baseline gap-2">
            <code className="text-md font-mono text-foreground">$IMPALA_BRANCH</code>
            <span className="text-md text-muted-foreground">— Branch name</span>
          </div>
        </div>
      </div>
    </div>
  );
}
