import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/invoke";
import { launchAgentHeadless } from "./agent-launch";
import { createAutomationRunDispatcher } from "./automation-run-dispatcher";
import { runPtySessionId, RUN_PANE_ID } from "./pane-ids";
import { encodePtyInput } from "./encode-pty";
import { useDataStore, useUIStore } from "../store";
import { isAutomationsProject } from "./automations-project";
import type { Automation, Worktree } from "../types";

export interface AutomationDueEvent {
  run_id: string;
  automation: Automation;
  instructions_path: string;
  worktree_path?: string | null;
}

const dispatchAutomationRun = createAutomationRunDispatcher(
  (payload: AutomationDueEvent) => {
    executeRun(payload).catch((e) =>
      console.error("automation run failed:", e),
    );
  },
);

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "automation"
  );
}

function branchStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Executes automation runs dispatched by the Rust scheduler: fresh worktree,
 * setup script (fire-and-forget, mirrors the New Worktree flow), headless
 * agent launch pointed at the run's immutable Markdown instructions. Called
 * once from App.
 */
export function startAutomationExecutor(): () => void {
  let cancelled = false;
  const unlisten = listen<AutomationDueEvent>("automation-due", (event) => {
    dispatchAutomationRun(event.payload);
  }).then(async (stopListening) => {
    if (cancelled) {
      stopListening();
      return undefined;
    }

    try {
      const pending = await invoke<AutomationDueEvent[]>(
        "list_pending_automation_runs",
      );
      if (!cancelled) {
        for (const run of pending) dispatchAutomationRun(run);
      }
    } catch (e) {
      console.error("failed to recover pending automation runs:", e);
    }

    return stopListening;
  });

  return () => {
    cancelled = true;
    unlisten.then((fn) => fn?.());
  };
}

async function executeRun({
  run_id,
  automation,
  instructions_path,
  worktree_path,
}: AutomationDueEvent) {
  try {
    let runPath: string;
    if (worktree_path) {
      // Recovery after the run directory/worktree was allocated but before
      // launch was reported. Reuse it so the immutable instructions keep the
      // same worktree context.
      runPath = worktree_path;
    } else if (automation.repo_path === "") {
      // Global automation — no project to branch from. Runs in a fresh
      // scratch git repo so the agent's output is reviewable as an
      // uncommitted diff when the run is opened.
      runPath = await invoke<string>("prepare_automation_run_dir", {
        name: automation.name,
        runId: run_id,
      });
      // Scratch dirs have no creation-time agent setting (create_worktree
      // writes it for project worktrees) — persist it so a pane relaunch
      // after a daemon restart resolves the right agent.
      await invoke("set_setting", {
        key: "selectedAgent",
        scope: runPath,
        value: automation.agent,
      }).catch(() => {});
    } else {
      const branch = `auto/${slugify(automation.name)}-${branchStamp()}`;
      const worktree = await invoke<Worktree>("create_worktree", {
        repoPath: automation.repo_path,
        branchName: branch,
        baseBranch: null,
        existing: false,
        initialTitle: automation.name,
        agent: automation.agent,
        automationRunId: run_id,
      });
      runPath = worktree.path;

      // Sidebar list refresh — only meaningful when this project is selected.
      if (useUIStore.getState().selectedProject?.path === automation.repo_path) {
        const wts = await invoke<Worktree[]>("list_worktrees", {
          repoPath: automation.repo_path,
        });
        useDataStore.getState().setWorktrees(wts);
      }

      runSetupScript(automation.repo_path, worktree).catch(() => {});
    }

    await invoke("finalize_automation_run_instructions", {
      runId: run_id,
      worktreePath: runPath,
    });

    await launchAgentHeadless({
      worktreePath: runPath,
      // Global runs have no project; the scratch dir itself scopes agent
      // flag resolution (falls through to global-scope settings).
      projectPath: automation.repo_path || runPath,
      agent: automation.agent,
      prompt: `Read and execute the automation instructions in \`${instructions_path}\`.`,
    });

    await invoke("report_automation_run", {
      runId: run_id,
      worktreePath: runPath,
      status: "launched",
      error: null,
    });

    // Refresh the virtual Automations project's run list if it's on screen —
    // after the report, since the listing reads worktree_path off the run row.
    if (
      automation.repo_path === "" &&
      isAutomationsProject(useUIStore.getState().selectedProject)
    ) {
      const wts = await invoke<Worktree[]>("list_automation_run_worktrees");
      useDataStore.getState().setWorktrees(wts);
    }
  } catch (e) {
    await invoke("report_automation_run", {
      runId: run_id,
      worktreePath: null,
      status: "failed",
      error: String(e),
    }).catch(() => {});
  }
}

async function runSetupScript(projectPath: string, worktree: Worktree) {
  const config = await invoke<{ setup?: string }>("read_project_config", {
    projectPath,
  });
  if (!config.setup?.trim()) return;

  const ptyId = runPtySessionId(worktree.path);
  await invoke("pty_spawn", {
    sessionId: ptyId,
    cwd: worktree.path,
    envVars: {
      IMPALA_PROJECT_PATH: projectPath,
      IMPALA_WORKTREE_PATH: worktree.path,
      IMPALA_BRANCH: worktree.branch,
    },
  });
  const data = useDataStore.getState().getWorktreeDataState(worktree.path);
  useDataStore.getState().updateWorktreeDataState(worktree.path, {
    paneSessions: { ...data.paneSessions, [RUN_PANE_ID]: ptyId },
  });
  await invoke("pty_write", {
    sessionId: ptyId,
    data: encodePtyInput(config.setup + "\n"),
  });
  useUIStore.getState().updateWorktreeNavState(worktree.path, {
    setupRanAt: Date.now(),
  });
}
