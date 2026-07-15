# Impala

A desktop app for reviewing git worktree changes. Surfaces a worktree's diffs, lets reviewers attach inline annotations, and runs project-defined scripts (Setup / Actions) inside per-worktree PTYs.

## Language

**Project**:
A repository the user has registered with Impala. Contains the project root path and persists its config in `.impala/config.json`. Hosts one or more **Worktrees**.
_Avoid_: Repo, repository (use Project when referring to the Impala-tracked entity).

**Worktree**:
A git worktree of a **Project**, owning its own branch and working directory. The unit of review and the unit of script execution.
_Avoid_: Branch, checkout (a Worktree has a branch but is not the branch itself).

**Base branch**:
The branch a new **Worktree** is forked from at creation, configured per **Project**.
_Avoid_: Start point, source branch; do not reuse for the diff-comparison base (see Flagged ambiguities).

**Setup script**:
A single shell script stored on the **Project** that runs once, automatically, after a **Worktree** is created. Lifecycle is "fire-and-forget on creation."
_Avoid_: Init script, bootstrap script.

**Action**:
A named, on-demand shell script stored on the **Project**. Each Action has a stable ID, a user-editable name, and a script body. Triggered by the user from the **Worktree**'s play button or the actions dropdown.
_Avoid_: Run script (legacy term — singular "the run script" no longer exists; an Action is one of several), command, task.

**Run pane**:
The single shared PTY pane per **Worktree** in which any **Action** executes. Identified by `RUN_PANE_ID`. Only one Action can occupy the Run pane at a time per Worktree.
_Avoid_: Run terminal (the Run pane is a tab inside the tabbed terminal, not a separate terminal).

**Last-used action**:
The Action that the **Worktree**'s play button (and Cmd+Shift+R) will fire next. Tracked per-Worktree in memory; resets to the first Action on app restart or when the referenced Action is deleted.
_Avoid_: Default action (the project has no notion of a globally "default" Action — only a per-Worktree last-used pointer).

**Annotation**:
An inline review comment anchored to a file and line range in a **Worktree**. Surfaced via the in-app reviewer and the `impala` MCP server.
_Avoid_: Comment, note (Annotation is the canonical term).

**Companion mode**:
A global, persisted posture in which Impala serves solely as the review surface for work driven by an external agent app (e.g. the Codex desktop app). The terminal surface, **Actions**, and all **Worktree** management are hidden; a read-only sidebar lists every **Project** with its **Worktrees** (name only), and selecting one gives the usual diffs, commits, **Annotations**, and single-file preview. Entered and exited via the command palette; the unnamed alternative is the full experience. Layout-only: background terminal sessions keep running and are restored on exit.
_Avoid_: Viewer mode, diff-only mode, review mode (the full experience is also review).

**Remote provider**:
The hosting service backing a **Project**'s git remote — currently GitHub or Bitbucket Cloud. Determines whether Impala can surface a **Pull request status** for the Project's **Worktrees**; a Project whose remote matches no known provider is unsupported.
_Avoid_: Remote (the bare git origin URL is not the provider), host, forge, integration.

**Pull request status**:
The state of the pull request associated with a **Worktree**'s branch, surfaced in the sidebar: whether a pull request exists and, if so, whether it is open, merged, or closed, along with its review decision and checks rollup. Provider-neutral — the same concept regardless of **Remote provider**. A **Worktree** whose branch has no pull request — including a Project's mainline branches — has no Pull request status.
_Avoid_: Check status (the checks rollup is only one component), merge status.

**Issue tracker**:
The external system backing a **Project**'s tickets — currently Linear or Jira, or none. A per-**Project**, user-selected attribute. Unlike **Remote provider**, it is _not_ inferable from the git remote (Linear and Jira are independent of where the code is hosted), so the user picks it explicitly per Project. Determines which backend powers issue search and the **Issue**-to-**Worktree** flow.
_Avoid_: Integration, issue source, issue provider.

**Issue**:
A single ticket in a **Project**'s **Issue tracker**, identified by a human-readable key (Linear `ENG-123`, Jira `RAC-45`). The thing a **Worktree** can be created from and linked to; its description and comments are surfaced to the agent as context.
_Avoid_: Ticket, task, story.

## Relationships

- A **Project** has one **Setup script** and zero-or-more **Actions**.
- A **Project** has one **Base branch** (the fork point for new **Worktrees**; may be unset).
- A **Project** has one-or-more **Worktrees**.
- A **Worktree** has one **Run pane**, in which at most one **Action** runs at a time.
- A **Worktree** has one **Last-used action** pointer (may be unset on cold start).
- A **Worktree** has zero-or-more **Annotations**.
- A **Project**'s git remote has one **Remote provider**, or none when the remote is unsupported.
- A **Worktree** has zero-or-one **Pull request status** (none when its branch has no pull request, or the **Remote provider** is unsupported).
- A **Project** has zero-or-one **Issue tracker** (Linear, Jira, or none), chosen explicitly by the user.
- A **Worktree** is created from and linked to zero-or-one **Issue** from its **Project**'s **Issue tracker**.

## Example dialogue

> **Dev:** "When the user clicks the play button, which **Action** runs?"
> **Designer:** "Whichever the **Last-used action** points at. If nothing's been run in this **Worktree** yet, it falls back to the first **Action** in the **Project**'s list."
> **Dev:** "And if they pick a different one from the dropdown while one is already running?"
> **Designer:** "They can't — the dropdown items are disabled until the **Run pane** is idle. Stop first, then pick."

## Flagged ambiguities

- "Base branch" is overloaded. As a domain term it means the **Base branch** above — the per-**Project** fork point for new **Worktrees**. A separate branch is auto-detected per-**Worktree** as the _comparison base_ for computing that Worktree's diff and diverged commits; despite sharing the name in code (`baseBranch`), it is not the **Base branch** setting.
- "Run script" (singular) was the pre-Actions term for the only on-demand script a Project could have. After the Actions feature lands, "the run script" no longer exists as a domain concept — there are only **Actions**, of which there may be many. The migrated legacy `run` field is imported as one **Action** named "Run."
