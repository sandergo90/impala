# Actions replace the singular Run script

The Project config previously had `setup` and `run` — exactly one on-demand script, fronted by a single play button and Cmd+Shift+R. Users requested multiple named alternatives (e.g. `Worktree`, `Worktree | Light`, `Dev`), mirroring Codex's per-environment Actions. We considered keeping `run` as a privileged "default" alongside an `actions[]` array, but that creates two parallel concepts to reconcile (which one does the play button fire? which one does the hotkey hit?). Instead we replaced `run` with `actions[]` outright and migrated the legacy field to `actions[0]` named "Run" via a one-shot rewrite in the Rust deserializer.

## Why

- **One canonical noun.** "An **Action**" is the only on-demand executable concept; no special-cased "the run script" lives alongside it.
- **The play button has unambiguous semantics.** It fires the **Last-used action** for the current Worktree (cold-start fallback: `actions[0]`); the dropdown picks a different one. With `run` retained alongside, the button would have to choose between firing `run` or the last-used Action.
- **Schema migration is one-time.** The Rust deserializer accepts the old shape, synthesizes an Action with a fresh stable ID, and writes the new shape back on first read. After one Project open, no callsite has to know the legacy field existed.
- **Setup remains separate.** Setup runs automatically on Worktree creation — a different lifecycle from on-demand Actions. Conflating them would have widened the migration without buying anything.

## Consequences

- The legacy `run` field is gone from the on-disk schema after the first read of any pre-Actions config; there is no "compatibility mode" to maintain.
- Empty-actions Projects are now possible (a Project with `setup` but no Actions). The play button disables and the dropdown shows an "Edit actions…" link routing to project settings.
- Per-Action persistent state (e.g. last-used) must reference the stable `id`, not the array index or name, so renames and reorders don't silently invalidate pointers.
