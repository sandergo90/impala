# Phase 2 — Scheduled Automations: Review Queue Polish

Phase 1 shipped the core loop. Phase 2 makes finished runs impossible to miss and creation instant.

## Unseen-run badge (superset's failure badge, generalized)

- `automation_runs.seen` column (guarded ALTER for Phase-1 DBs). A run becomes badge-worthy when it reaches `completed`/`failed`; `mark_automation_runs_seen(repo)` flips only finished runs, so a run "seen" while still launched re-badges on completion.
- Commands: `count_unseen_automation_runs(repo)` → `{total, failed}`, `mark_automation_runs_seen(repo)` (emits only when rows changed — prevents refresh loops).
- Sidebar Automations entry (expanded + collapsed) shows a count pill/dot — red when any unseen run failed, primary otherwise. Opening the Automations view marks finished runs seen.

## Completion notifications

- Runs already fire the generic "Agent Complete" notification via the Stop event; specialize instead of duplicating: hook server emits `automation-run-completed` {worktree_path, automation_name} (before agent-status, same channel ordering), and useAgentNotifications swaps in "Automation Complete — \"<name>\" finished, diff ready to review" for that worktree's idle notification.
- No click-through targeting: send_notification (notify_rust) has no action payload. Out of scope.

## Template gallery

- `lib/automation-templates.ts` — small curated set, review-flavored, prompts instructed to write output into the worktree so the diff carries the result (standup digest → docs/standup/<date>.md, etc.): Daily standup digest, Daily bug scan, Weekly release notes draft, Dependency sweep, Repo health check.
- Empty state becomes "Start from a template" cards; clicking prefills the create dialog.

## Verify

- cargo test: seen counting, mark-seen only touches finished runs.
- typecheck; live: run completes → badge appears + specialized notification; opening view clears badge; template card prefills dialog.
