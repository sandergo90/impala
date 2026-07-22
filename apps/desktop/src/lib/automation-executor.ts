import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/invoke";
import { launchAgentHeadless } from "./agent-launch";
import { runPtySessionId, RUN_PANE_ID } from "./pane-ids";
import { encodePtyInput } from "./encode-pty";
import { useDataStore, useUIStore } from "../store";
import type { Automation, Worktree } from "../types";

export interface AutomationDueEvent {
  run_id: string;
  automation: Automation;
}

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
 * agent launch with the automation's prompt. Called once from App.
 */
export function startAutomationExecutor(): () => void {
  const unlisten = listen<AutomationDueEvent>("automation-due", (event) => {
    executeRun(event.payload).catch((e) =>
      console.error("automation run failed:", e),
    );
  });
  return () => {
    unlisten.then((fn) => fn());
  };
}

async function executeRun({ run_id, automation }: AutomationDueEvent) {
  try {
    let runPath: string;
    if (automation.repo_path === "") {
      // Global automation — no project to branch from. Runs in a fresh
      // scratch git repo so the agent's output is reviewable as an
      // uncommitted diff when the run is opened.
      runPath = await invoke<string>("prepare_automation_run_dir", {
        name: automation.name,
      });
    } else {
      const branch = `auto/${slugify(automation.name)}-${branchStamp()}`;
      const worktree = await invoke<Worktree>("create_worktree", {
        repoPath: automation.repo_path,
        branchName: branch,
        baseBranch: null,
        existing: false,
        initialTitle: automation.name,
        agent: automation.agent,
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

    await launchAgentHeadless({
      worktreePath: runPath,
      // Global runs have no project; the scratch dir itself scopes agent
      // flag resolution (falls through to global-scope settings).
      projectPath: automation.repo_path || runPath,
      agent: automation.agent,
      prompt: automation.prompt,
    });

    await invoke("report_automation_run", {
      runId: run_id,
      worktreePath: runPath,
      status: "launched",
      error: null,
    });
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
