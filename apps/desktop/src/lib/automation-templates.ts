export interface AutomationTemplate {
  emoji: string;
  name: string;
  description: string;
  /** 5-field cron. */
  schedule: string;
  prompt: string;
}

/**
 * Curated starting points. Prompts write their output into the worktree so
 * the run's result shows up as a reviewable diff, not just terminal scroll.
 */
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    emoji: "📋",
    name: "Daily standup digest",
    description: "Yesterday's git activity, grouped and summarized",
    schedule: "0 9 * * MON-FRI",
    prompt:
      "Summarize the last 24 hours of git activity in this repository (all branches). Group by author, list the themes of the work, and call out anything that looks stuck or half-finished. Write the digest to docs/standups/<today's date>.md — create the directory if needed.",
  },
  {
    emoji: "🔍",
    name: "Daily bug scan",
    description: "Hunt for bugs in recently changed code",
    schedule: "0 7 * * MON-FRI",
    prompt:
      "Review the code changed in the last 24 hours for bugs: broken edge cases, race conditions, error handling gaps, and regressions. Fix the clear-cut ones directly in this worktree. For anything debatable, write it up in docs/bug-scan/<today's date>.md instead of changing code.",
  },
  {
    emoji: "📝",
    name: "Weekly release notes draft",
    description: "Draft notes from the week's merged work",
    schedule: "0 17 * * FRI",
    prompt:
      "Draft release notes covering everything merged to the default branch in the last 7 days. Write user-facing descriptions (features, fixes, breaking changes), not commit messages. Save the draft to docs/release-notes/draft-<today's date>.md.",
  },
  {
    emoji: "📦",
    name: "Dependency sweep",
    description: "Outdated deps and security advisories",
    schedule: "0 8 * * MON",
    prompt:
      "Check this project's dependencies for outdated versions and known security advisories. Apply safe patch/minor updates directly (run the project's install and typecheck to verify). Write a summary of what you updated, what you skipped, and why to docs/dependency-sweep/<today's date>.md.",
  },
  {
    emoji: "🧪",
    name: "Repo health check",
    description: "Typecheck, lint, and tests — fix the trivial breaks",
    schedule: "0 8 * * MON-FRI",
    prompt:
      "Run this project's typecheck, lint, and test suites. Fix trivial failures (imports, types, formatting) directly in this worktree. For anything non-trivial, write a triage note to docs/health/<today's date>.md with the failing output and your diagnosis.",
  },
];
