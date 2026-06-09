# FileViewer renders markdown via CodeMirror + ProseMark live-preview

`FileViewer` previously offered a `Rendered` / `Raw` toggle: rendered markdown went through `react-markdown` + `remark-gfm` + `react-syntax-highlighter`; raw markdown went through impala's existing CodeMirror-based `CodeEditor`. We are replacing both modes with a single CodeMirror 6 view built on `@prosemark/core`, modeled on `joelbqz/writer-computer`'s editor. The same view both renders the markdown (headings styled, tables rendered as `<table>` widgets, mermaid blocks rendered, fenced code highlighted via `@codemirror/language-data`) and lets the user edit it; markdown syntax marks (`#`, `**`, `-`) collapse into rendered output, and reappear at the caret. Edits flow through the existing `useEditorDocsStore` save/dirty/watcher plumbing, so save semantics for markdown match every other editable file in `FileViewer`.

This applies only to `FileViewer`.

## Why

- **Live-preview editing is the whole point.** `@prosemark/core`'s caret-driven syntax-mark collapse is what justifies its complexity. A read-only port would have inherited the dependency without earning the affordance, so we committed to making `FileViewer` markdown editable at the same time. The save plumbing was already there for non-markdown files (`useEditorDocsStore`), so the marginal cost is only the renderer swap.
- **One view, no toggle.** Writer-computer ships no `Rendered`/`Raw` switch because prosemark makes raw mode redundant — the source is visible at the caret. Keeping the toggle would have imported impala's old "render-vs-source" mental model into a world where it doesn't earn its keep. The existing `Open in Editor` button still covers the "give me the whole file as plain text" case.
- **Port wholesale rather than reinvent.** Tables, mermaid, HTML blocks, image-src resolution, formatting shortcuts, and the syntax-highlight theme are ported directly from writer-computer's `editor-area/`. We pin `@prosemark/core` at exact `0.0.7` rather than vendoring; the package is ~170 KB unpacked and the maintainer is active. If it goes sideways we can vendor it in a day, but pre-paying that tax loses upstream improvements.
- **Skip what doesn't translate.** `wiki-link-extension`, `editor-tabs`, `new-tab-page`, and `editor-context-menu` from writer-computer are skipped: impala already has its own tab/worktree system, and `[[wiki]]` syntax has no resolution target in a worktree.

## Consequences

- **New `@prosemark/core` dependency at v0.0.7** — pre-1.0 single-maintainer package. Pinned to the exact version; breaking changes between 0.0.x releases are expected and we'll evaluate each upgrade.
- **Two CodeMirror configurations live side-by-side.** `CodeEditor.tsx` continues to handle non-markdown text files; the new prosemark editor handles `.md` / `.mdx` / `.markdown`. They share no code by design — different concerns, different decorations.
- **New theme tokens** — `--color-link`, `--color-code-background`, `--color-editor-selection`, and a small set of prosemark-syntax tokens — are added to impala's theme system. Default-light and default-dark themes ship values for them; user `customThemes` fall back to the default values when they don't define their own.
- **Linear attachment images in worktree `.md` files now render via a `WidgetType` instead of a React component.** Same `fetch_linear_attachment` Tauri command, but the loading/error states are rendered imperatively into the widget DOM. Behavior is preserved.
- **Relative non-markdown links improve.** Today, clicking a relative `.pdf` or `.png` link in a worktree `.md` does nothing useful. The new editor routes those through `openPath` (system default app), markdown links through `openFileTab`, externals through `openUrl`.
- **Frontmatter lands as a follow-up.** PR 1 ships the renderer swap; PR 2 adds writer-computer's `FrontmatterPanel` above the editor and splits the document buffer into frontmatter + body. Sequencing keeps the buffer-model change isolated from the renderer change.
