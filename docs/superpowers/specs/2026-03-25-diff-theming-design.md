# Diff View Theming

## Overview

Make the @pierre/diffs integration use the active theme's colors so diffs match the rest of the app (UI, terminal, everything).

## Approach

Extend `applyTheme()` to set Pierre's `--diffs-*-override` CSS variables on `:root`, derived from the theme's UI and terminal colors. Pierre picks these up automatically. Also switch the Pierre base theme (`pierre-dark` / `pierre-light`) based on `theme.type` for correct syntax highlighting.

## CSS Variable Mappings

Derived from the theme's existing tokens and set in `applyTheme()`:

| Pierre CSS Variable | Derived From | Notes |
|---|---|---|
| `--diffs-bg-context-override` | `ui.background` | Context line background |
| `--diffs-bg-buffer-override` | `ui.background` | Empty space/padding background |
| `--diffs-bg-separator-override` | `ui.accent` | Hunk separator background |
| `--diffs-bg-hover-override` | `ui.accent` | Line hover background |
| `--diffs-fg-number-override` | `ui.border` | Line number color (muted) |
| `--diffs-bg-addition-override` | `terminal.green` at ~10% opacity over `ui.background` | Added line background |
| `--diffs-bg-addition-hover-override` | `terminal.green` at ~15% opacity over `ui.background` | Added line hover |
| `--diffs-bg-addition-emphasis-override` | `terminal.green` at ~25% opacity | Inline word-level addition |
| `--diffs-bg-deletion-override` | `terminal.red` at ~10% opacity over `ui.background` | Deleted line background |
| `--diffs-bg-deletion-hover-override` | `terminal.red` at ~15% opacity over `ui.background` | Deleted line hover |
| `--diffs-bg-deletion-emphasis-override` | `terminal.red` at ~25% opacity | Inline word-level deletion |

The opacity blending is done with `color-mix(in srgb, <color> <percent>, <background>)` in CSS, which is well-supported.

## Changes to DiffView.tsx

Replace hardcoded `theme: "pierre-dark"` with a reactive value based on the active theme's type:

```ts
const activeThemeId = useUIStore((s) => s.activeThemeId);
const pierreTheme = resolveThemeById(activeThemeId, useUIStore.getState().customThemes).type === "dark"
  ? "pierre-dark" : "pierre-light";
```

## File Changes

- **Modify:** `apps/desktop/src/themes/apply.ts` — add Pierre CSS variable mappings to `applyTheme()`
- **Modify:** `apps/desktop/src/components/DiffView.tsx` — dynamic `pierre-dark`/`pierre-light` selection
