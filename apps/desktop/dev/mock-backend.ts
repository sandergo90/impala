// Mock Tauri backend for the browser dev harness.
//
// Answers `POST /<command>` with canned JSON so the real Impala SPA can boot in
// plain Chrome (where the React DevTools + Chrome performance profiler work,
// unlike Tauri's WKWebView). Pair with dev/dev-browser.html. See dev/README.md.
//
//   bun dev/mock-backend.ts          # populated demo project (default)
//   FILES=2000 bun dev/mock-backend.ts   # stress the changed-files list
//   POPULATE=0 bun dev/mock-backend.ts   # empty "no projects" state
//
// Every command is logged once so you can see what the app calls on boot.

const PORT = Number(process.env.PORT ?? 8787);
const POPULATE = process.env.POPULATE !== "0";
const FILE_COUNT = Number(process.env.FILES ?? 600);

const PROJECT = "/tmp/impala-demo/acme";
const WT = "/tmp/impala-demo/acme-feature";

// Commands that need a specific shape to render. Unlisted commands fall back to
// smartDefault() below ([] for list-shaped names, null otherwise).
const FIXED: Record<string, unknown> = {
  set_window_vibrancy: null,
  list_system_fonts: ["Geist", "Menlo", "monospace"],
  get_hook_port: 51234,
  save_projects: null,
  get_default_worktree_base_dir: "/tmp/impala-demo",
  read_hotkey_overrides: {}, // store indexes this object by hotkey id
  get_agent_statuses: {},
  load_projects: [], // overwritten below when POPULATE
};

if (POPULATE) {
  const commits = Array.from({ length: 40 }, (_, i) => ({
    hash: `${(0x100000 + i).toString(16)}abcdef`,
    message: `feat: change number ${i}`,
    date: "2026-06-01T10:00:00",
    additions: 5 + i,
    deletions: i,
  }));
  const changedFiles = Array.from({ length: FILE_COUNT }, (_, i) => ({
    path: `src/app/module${Math.floor(i / 20)}/file${i}.ts`,
    status: i % 7 === 0 ? "A" : "M",
  }));
  Object.assign(FIXED, {
    load_projects: [PROJECT],
    list_worktrees: [
      { path: WT, branch: "feature/perf", head_commit: "deadbeef", title: "Perf work" },
      { path: PROJECT, branch: "main", head_commit: "cafef00d", title: null },
    ],
    discover_project_icon: null,
    get_project_issue_tracker: { kind: "none" },
    read_project_config: { setup: "", run: "", actions: [] },
    get_git_info: { author_name: "Dev" },
    detect_base_branch: "main",
    get_diverged_commits: commits,
    get_uncommitted_files: changedFiles,
    get_all_changed_files: changedFiles,
    get_changed_files: changedFiles,
    get_uncommitted_diff: "",
    get_full_branch_diff: "",
    get_last_turn_diff: "",
    has_last_turn_snapshot: false,
    get_all_worktree_issues: [],
    get_pr_status: null,
  });
}

// Default by command name so .map()/.length on the result is always safe.
function smartDefault(cmd: string): unknown {
  if (
    cmd.startsWith("list_") ||
    cmd.startsWith("get_all_") ||
    cmd.startsWith("search_") ||
    cmd.startsWith("check_") ||
    cmd.endsWith("_files") ||
    cmd.endsWith("_commits") ||
    cmd.endsWith("_annotations")
  ) {
    return [];
  }
  return null;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const seen = new Set<string>();

Bun.serve({
  port: PORT,
  fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const cmd = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (!seen.has(cmd)) {
      seen.add(cmd);
      console.log("CALL", cmd);
    }
    const value = cmd in FIXED ? FIXED[cmd] : smartDefault(cmd);
    return new Response(JSON.stringify(value ?? null), {
      headers: { "Content-Type": "application/json", ...CORS },
    });
  },
});

console.log(
  `mock backend → http://localhost:${PORT}  (POPULATE=${POPULATE}, FILES=${FILE_COUNT})`,
);
