# Phase 1 — Scheduled Automations: Core Loop

Automations = name + prompt + schedule + agent, per project. A due automation creates a fresh worktree, launches the agent with the prompt, and the finished run is a reviewable diff. Runs only while the app is open. Research: `docs/plans/scheduled-automations-research.md` (gitignored).

Locked decisions: sidebar-level Automations view (superset-style prominence, user-confirmed); cron string + preset picker (not RRule); missed runs catch up at most once; fresh worktree per run; no prompt version history.

## Rust (backend/tauri)

1. **Deps**: `cron` crate for next-occurrence math (5-field cron; prepend seconds field internally), evaluated in local time via chrono.
2. **`automations.rs`** (new module):
   - `automations` table: id, repo_path, name, prompt, agent ("claude"|"codex"), schedule (cron), enabled, next_run_at (unix seconds), created_at, updated_at.
   - `automation_runs` table: id, automation_id, scheduled_for, worktree_path (nullable), status (pending|launched|completed|failed|skipped), error, created_at. UNIQUE(automation_id, scheduled_for) = idempotency.
   - Commands: `list_automations(repo)`, `create_automation`, `update_automation`, `delete_automation` (cascades runs), `set_automation_enabled` (resume recomputes next_run_at from now), `run_automation_now`, `list_automation_runs(repo)`, `report_automation_run(run_id, worktree_path?, status, error?)`, `cron_next_occurrences(schedule, n)` for the picker preview + validation.
3. **Scheduler**: tokio task in setup, tick ~30s. Due = enabled AND next_run_at <= now. Per due automation: insert run row (scheduled_for = old next_run_at → catch-up-at-most-one falls out naturally), advance next_run_at strictly past now, emit `automation-due` {run_id, repo_path, automation fields} to main. Run-now shares the same dispatch helper with scheduled_for = now.
4. **Completion**: hook server Stop handler — worktree_path with a `launched` run → `completed`, emit `automation-runs-changed`.

## Frontend (apps/desktop)

5. **`lib/agent-launch.ts`** (new): headless agent launch for a worktree that has never launched its agent — spawn the deterministic agent PTY session, await shell ready, write `buildLaunchCommand(agent, flags, prompt)`, mark `agentLaunched: true`. Reuses lib/agent.ts + pty helpers; TabbedTerminals untouched (it reattaches via existing isNew=false path).
6. **`lib/automation-executor.ts`** (new): on `automation-due` → `create_worktree` (branch `auto/{slug}-{timestamp}`, automation's agent) → refresh worktree list → headless launch → `report_automation_run(launched)`. Any failure → `report_automation_run(failed, error)`.
7. **Automations view**: route `/automations` + sidebar entry (clock icon) in the left sidebar. List: status dot, name, schedule text, next run, last run, agent, paused badge. Create/edit dialog: name, prompt textarea, agent picker, schedule picker (Hourly / Daily / Weekdays / Weekly + time, Custom = raw cron) with next-occurrences preview. Row actions: Run now, pause/resume, edit, delete. Per-automation recent runs; clicking a run selects its worktree.

## Verify

- `cargo test`: cron next-occurrence math, run dedup, CRUD round-trip.
- `bun run typecheck`.
- Live: every-2-minute automation fires → worktree appears with agent running the prompt → Stop marks run completed → clicking the run opens the worktree diff. Relaunch app after a missed slot → exactly one catch-up run.

Out of scope (Phase 2/3): sidebar badge + notifications, template gallery, MCP tools/skill, existing-worktree mode.
