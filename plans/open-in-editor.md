# Open in Editor

## Summary

Add a split button in the header bar (near the branch name) that opens the current worktree in the user's preferred editor.

## Design Decisions

- **Button location:** Left side of header, near branch name / worktree context
- **Button style:** Split button — primary click opens in last-used editor, chevron opens dropdown menu
- **Supported editors:** Cursor, VS Code, Zed, WebStorm, Sublime Text
- **Preference storage:** Zustand UI store (`impala-ui-state` in localStorage)
- **Execution:** Backend Tauri command `open_in_editor` — runs `open -a "<app>" <path>` on macOS
- **Default:** First in list (Cursor) until user picks another

## Not in Scope

- Per-project editor defaults
- Auto-detection of installed editors
- Finder / Terminal entries in dropdown
- Dedicated settings pane for editor choice
- Linux / Windows support

## Implementation

### 1. Backend: `open_in_editor` Tauri command

In `backend/tauri/src/lib.rs`:
- New command: `open_in_editor(editor: String, path: String) -> Result<(), String>`
- Map editor name to macOS app name
- Run `open -a "<app name>" <path>` via `std::process::Command`
- Return error if command fails
- Register in `.invoke_handler()`

### 2. Store: editor preference

In `apps/desktop/src/store.ts`:
- Add `preferredEditor: string` field to UIStore (default: `"cursor"`)
- Add `setPreferredEditor` action
- Include in persisted state

### 3. UI: OpenInEditorButton component

New component `apps/desktop/src/components/OpenInEditorButton.tsx`:
- Split button: `[icon] Open in Cursor [▾]`
- Primary click: invoke `open_in_editor` with preferred editor + active worktree path
- Chevron click: toggle dropdown menu
- Dropdown: list of editors, clicking one opens in that editor AND sets it as preferred
- Close dropdown on outside click

### 4. Header integration

In `apps/desktop/src/App.tsx`:
- Add `<OpenInEditorButton />` near the branch name / worktree context area
- Only visible when a worktree is selected
