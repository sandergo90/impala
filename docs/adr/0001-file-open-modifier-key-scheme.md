# File-open destination is decided by modifier keys, not a dropdown

When the in-app file editor was added, we needed a way for users to choose between opening files in Impala's editor versus an external IDE (Cursor, VS Code, Zed, WebStorm, Sublime). We considered adding "Impala" as a sixth entry in the existing `OpenInEditorButton` dropdown alongside the IDEs, but instead made the choice a function of the click gesture: single-click on any file-path trigger opens in Impala (preview tab, jumps to line if given), Cmd+click opens in the user's `preferredEditor`. Pinning stays on double-click.

## Why

- **No new global preference to manage or migrate.** A dropdown entry would have required deciding the default for new vs. existing users and a discoverability nudge. The modifier scheme has no preference at all.
- **Existing muscle memory survives.** Cmd+click already opens in the preferred external editor (`AnnotationDisplay.tsx:39-45`); we kept that. The new behavior is on bare click, which was previously a no-op on those triggers.
- **The split button stays single-purpose.** `OpenInEditorButton` is unchanged — it's still purely "send me to my IDE." Adding Impala there would have been a no-op in `FileViewer` (file already shown in Impala) and meaningless in `MainView` (worktree is already open).
- **Discovery is automatic.** Users already click these surfaces; the new behavior surfaces immediately without a banner or tooltip campaign.

## Consequences

- All file-path triggers must follow the same scheme: annotation links, diff per-line button, FilesPanel rows, FileFinder results, terminal links. Inconsistency between surfaces erodes the contract.
- The DiffView per-line button is the weakest discoverability point for the Cmd+click branch (buttons rarely carry modifier semantics). Mitigated by a tooltip that names both behaviors.
