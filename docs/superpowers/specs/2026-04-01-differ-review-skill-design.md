# `/differ-review` Skill for Annotation Review

## Summary

Replace the current "Send to Claude" mechanism (which pastes full annotation text into the PTY) with a Claude Code skill that instructs Claude to use the Differ MCP tools. Differ pastes `/differ-review` or `/differ-review <id>` into the terminal. The skill tells Claude to fetch annotations via MCP, address them, and resolve them.

## Design Decisions

- **Skill, not user command** — skills get clean names (`/differ-review`) without the `user:` prefix.
- **Installed at `~/.claude/skills/differ-review/SKILL.md`** — global, not per-project. Available in every worktree. Uses the standard subdirectory convention.
- **Auto-installed on app startup** — alongside the existing hook installation in `install_claude_hooks()`. Overwrites on every launch to stay current with the latest skill definition.
- **Two modes** — `/differ-review` addresses all unresolved annotations; `/differ-review <id>` addresses a single annotation by ID.
- **MCP-first** — the skill instructs Claude to use `list_annotations`, `resolve_annotation`, and `list_files_with_annotations` MCP tools rather than working from pasted text.

## Skill File

Written to `~/.claude/skills/differ-review/SKILL.md`:

```markdown
---
name: differ-review
description: Review and address code review annotations from Differ. Use when asked to review annotations, or when invoked as /differ-review.
allowed-tools: mcp__differ__list_annotations, mcp__differ__resolve_annotation, mcp__differ__list_files_with_annotations, Read, Edit, Write, Grep, Glob
argument-hint: "[annotation-id]"
---

Review and address code review annotations using the Differ MCP server tools.

ARGUMENTS: If an annotation ID is provided as an argument, address only that annotation. Otherwise, address all unresolved annotations.

## Steps

1. Call `mcp__differ__list_annotations` to fetch annotations (unresolved ones). If an ID argument was given, find that specific annotation.
2. For each annotation:
   a. Read the file at the annotated line to understand the context
   b. Address the feedback (make the requested change, fix the issue, etc.)
   c. Call `mcp__differ__resolve_annotation` with the annotation's `id` to mark it done
3. After addressing all annotations, briefly summarize what was changed.

## Notes

- Annotations have: `id`, `file_path`, `line_number`, `side` (left/right), `body` (the review comment), `resolved` (boolean)
- Focus on unresolved annotations (`resolved: false`)
- The `body` field contains the reviewer's feedback — read it carefully and address the specific concern
- Always resolve annotations after addressing them so the reviewer can see progress in Differ
```

## Backend Changes

### New function: `install_differ_review_skill()`

Add to `hook_server.rs` (alongside `install_claude_hooks()`). Writes the skill file to `~/.claude/skills/differ-review/SKILL.md`.

Logic:
1. Resolve `~/.claude/skills/differ-review/` directory
2. Create directory if it doesn't exist
3. Write the `SKILL.md` file (overwrite every time — keeps it current)

The skill content is embedded as a `const &str` in the Rust code.

### Call on startup

In `lib.rs` setup, call `install_differ_review_skill()` right after `install_claude_hooks()`.

## Frontend Changes

### `useAnnotationActions.ts`

Change `handleSendToClaude` and `handleSendAllToClaude` to paste slash commands instead of prompt text.

**`handleSendToClaude` (single annotation):**

Before:
```typescript
const prompt = `Review and address the annotation on ${annotation.file_path} line ${annotation.line_number}: ${annotation.body}\n`;
await sendPromptToClaude(prompt);
```

After:
```typescript
await sendPromptToClaude(`/differ-review ${annotation.id}`);
```

**`handleSendAllToClaude` (all unresolved):**

Before:
```typescript
let prompt: string;
if (selectedFile) {
  prompt = `Review and address the annotations on ${selectedFile.path}\n`;
} else {
  const lines = unresolved.map(...);
  prompt = `Review and address the following annotations:\n${lines.join("\n")}\n`;
}
await sendPromptToClaude(prompt);
```

After:
```typescript
await sendPromptToClaude("/differ-review");
```

Note: The previous file-scoped filtering (`if (selectedFile)`) is dropped. The MCP `list_annotations` tool returns all unresolved annotations, and the skill works through all of them. This is intentional — the skill should address everything outstanding. If a user wants single-file scope, they can send individual annotations via the per-annotation "Claude" button.

## No MCP Server Changes

The MCP server already exposes `list_annotations`, `resolve_annotation`, and `list_files_with_annotations`. No changes needed.

## Error Handling

- **Skill file write failure**: log and continue, don't block app startup.
- **Skill not found by Claude**: if the file wasn't written, Claude will report an unknown command. The user can re-trigger setup from settings.
