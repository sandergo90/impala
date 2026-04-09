import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { projectSettingsRoute } from "../../router";
import { useDataStore } from "../../store";
import { useInvoke } from "../../hooks/useInvoke";

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

  const [claudeFlags, setClaudeFlags] = useState("");
  const [claudeFlagsLoaded, setClaudeFlagsLoaded] = useState(false);
  const claudeFlagsDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Reset loaded flag and clean up timers when projectPath changes
  useEffect(() => {
    loadedRef.current = false;
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      if (claudeFlagsDebounceRef.current) clearTimeout(claudeFlagsDebounceRef.current);
    };
  }, [projectPath]);

  // Load per-project claude flags
  useEffect(() => {
    setClaudeFlagsLoaded(false);
    invoke<string | null>("get_setting", { key: "claudeFlags", scope: projectPath })
      .then((val) => {
        setClaudeFlags(val ?? "");
        setClaudeFlagsLoaded(true);
      })
      .catch(() => setClaudeFlagsLoaded(true));
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

  const handleClaudeFlagsChange = (value: string) => {
    setClaudeFlags(value);
    if (!claudeFlagsLoaded) return;
    if (claudeFlagsDebounceRef.current) clearTimeout(claudeFlagsDebounceRef.current);
    claudeFlagsDebounceRef.current = setTimeout(async () => {
      try {
        if (value.trim()) {
          await invoke("set_setting", { key: "claudeFlags", scope: projectPath, value: value.trim() });
        } else {
          await invoke("delete_setting", { key: "claudeFlags", scope: projectPath });
        }
      } catch (e) {
        toast.error(`Failed to save claude flags: ${e}`);
      }
    }, 500);
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
