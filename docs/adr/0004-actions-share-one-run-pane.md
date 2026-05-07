# Actions share one Run pane per Worktree

The tabbed terminal already supports per-tab PTYs (`userTabPaneId` in `apps/desktop/src/lib/pane-ids.ts`), so we could give every Action its own terminal tab and let multiple Actions run concurrently per Worktree. We deliberately didn't. All Actions share the single Run pane (`RUN_PANE_ID`); only one Action per Worktree can occupy it at a time. Picking another Action from the dropdown is disabled while one is running — the user must press Stop first.

## Why

- **Preserves the existing single-run mental model.** Today `runStatus` is one tri-state (`idle | running | stopping`) per Worktree. Multi-pane execution would require a map keyed by Action ID and the play-button-becomes-stop-button affordance would need to know "stop *which* one." A future user will understand "one Action runs at a time per Worktree" before we can teach them anything more elaborate.
- **The dropdown is for picking the *next* Action, not for hot-swapping.** Refusing while running keeps the failure mode obvious (a no-op + visibly disabled items) instead of silently killing a 90-second build because the user clicked the wrong row.
- **Stable Action IDs make the upgrade cheap.** If the parallel-Actions case becomes load-bearing, we can lift `runStatus` to `Record<actionId, RunStatus>` and route writes to per-Action panes without touching the schema or the migration.

## Consequences

- A user who genuinely wants `Dev` and `Build` to run side-by-side has to spawn a second Worktree (or open a manual user-tab terminal and run the command there). This is the explicit boundary; if it bites enough users we revisit.
- The shared pane keeps scrollback continuous across Actions in the same Worktree. Output from a previous `Dev` run remains above the next `Build` invocation. Acceptable; users can clear the terminal manually.
