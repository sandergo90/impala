# Base branch is a local per-project setting, not shared project config

The per-**Project** **Base branch** (the branch new **Worktrees** fork from) is stored in the local SQLite `settings` table (`key = "baseBranch"`, `scope = project_path`), not in the repo-committed `.impala/config.json` where Setup/Teardown scripts and Actions live. We chose machine-local because the fork point is a personal workflow preference (one developer forks features from `develop`, another from a release branch) rather than a property of the repo the whole team must agree on — and committing it would churn `.impala/config.json` per-developer.

## Considered Options

- **`.impala/config.json` (shared, committed):** consistent with Setup/Teardown/Actions, but would force one base branch on the whole team and create noisy diffs.
- **SQLite settings, `scope = project_path` (chosen):** local to the machine, same mechanism as `claudeFlags`/`codexFlags`.

## Consequences

- Surprising inconsistency: most project config is shared via `.impala/config.json`, but Base branch is not. This ADR exists so that's a deliberate, documented choice rather than an oversight.
- The setting is seeded per-machine from `detect_base_branch()` the first time the project's settings page is opened; if a developer never opens it, new worktrees fork from `HEAD`.
