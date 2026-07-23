---
name: Impala
description: A native-feeling desktop workspace for reviewing Git worktree changes, themed end-to-end by the user's chosen color scheme.
colors:
  background: "#262624"
  foreground: "#E4E4E4"
  card: "#2D2D2B"
  popover: "#33332F"
  primary: "#E4E4E4"
  primary-foreground: "#262624"
  secondary: "#33332F"
  muted: "#33332F"
  muted-foreground: "#898987"
  accent: "#33332F"
  accent-foreground: "#E4E4E4"
  destructive: "#E34671"
  border: "#3A3A37"
  input: "#33332F"
  ring: "#4A4A47"
  sidebar: "#262624"
  sidebar-accent: "#33332F"
  sidebar-border: "#3A3A37"
  link: "#88C0D0"
  terminal-background: "#2D2D2B"
  terminal-green: "#3FA266"
  terminal-red: "#FC6B83"
  terminal-yellow: "#D2943E"
  terminal-blue: "#81A1C1"
  terminal-magenta: "#B48EAD"
  terminal-cyan: "#88C0D0"
typography:
  headline:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.5
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  section-label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    letterSpacing: "1.2px"
  code:
    fontFamily: "ui-monospace, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "14px"
    lineHeight: 1.5
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.875rem"
  chrome: "5px"
  full: "9999px"
spacing:
  hairline: "0.125rem"
  tight: "0.25rem"
  snug: "0.375rem"
  base: "0.5rem"
  row-x: "0.75rem"
  panel-x: "1rem"
  pane: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0 0.625rem"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.chrome}"
    padding: "0.25rem"
  button-ghost-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.375rem 0.75rem"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive}"
    rounded: "{rounded.lg}"
    height: "2rem"
  input-field:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "0.25rem 0.5rem"
    typography: "{typography.body}"
  tab-pill:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.chrome}"
    padding: "0.25rem 0.625rem"
  tab-pill-active:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
  pane-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    width: "8.25rem"
  pane-tab-active:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.375rem 0.5rem"
    typography: "{typography.body}"
  list-row-selected:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  popover-surface:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.25rem 0"
  dialog-surface:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "1rem"
  panel-header:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.foreground}"
    height: "2.75rem"
    padding: "0.25rem 0.5rem"
  activity-rail:
    backgroundColor: "{colors.sidebar}"
    width: "2.5rem"
    padding: "0.625rem 0"
---

# Design System: Impala

## 1. Overview

**Creative North Star: "The Instrument Panel"**

Impala is a workspace, not a page. Every surface exists to hold a developer's working context — a diff, a terminal, a file tree, a browser pane — visible simultaneously and reachable without navigation. The chrome is deliberately thin: 40px activity rail, 44px pane headers, 1px hairline borders, flat surfaces separated by tone rather than shadow. Nothing in the chrome is allowed to be more interesting than the content it frames. When you look at an Impala window, the eye should land on code, not on the application.

The system's defining property is that **it does not own its own colors**. Every visible hue comes from a user-selected theme (`src/themes/built-in.ts:216` ships five; `src/themes/import.ts` accepts more). A theme declares only five required tokens — `background`, `foreground`, `primary`, `border`, `accent` (`src/themes/types.ts:1-8`) — and `resolveTheme()` derives thirty-four CSS variables from them via `color-mix(in lab, ...)` (`src/themes/apply.ts:143-188`). `applyTheme()` writes those onto `document.documentElement` as inline custom properties (`src/themes/apply.ts:255-270`), which Tailwind v4's `@theme inline` block in `src/index.css:25-66` re-exports as utility-generating color tokens. Consequence: a component that writes `bg-accent` participates in the theme; a component that writes `bg-green-500` does not, and 100+ places currently do the latter (see Do's and Don'ts).

The second defining property is that **the whole interface scales from one number**. `setFontSize()` writes `document.documentElement.style.fontSize = "{n}px"` (`src/store.ts:242-245`, default 14, range 10–24 per `src/components/settings/AppearancePane.tsx:14-15`). Because Tailwind v4's `--spacing` is `0.25rem` and `--radius` is `0.625rem` (`src/index.css:69`), type, padding, gaps, heights and corner radii all scale together. At the 14px default, `text-sm` renders 12.25px, `px-3` renders 10.5px, and `rounded-lg` renders 8.75px — the numeric scale in this document is nominal (16px root); the shipped default is 87.5% of it.

This system explicitly rejects, per PRODUCT.md: *cramped low-contrast controls, tiny labels, ornamental dashboard styling, and unfamiliar interaction patterns*. It is not a dashboard. There are no cards-in-a-grid, no hero metrics, no decorative gradients, no illustration.

**Key Characteristics:**
- **Theme-owned, never hardcoded.** Color is a runtime input, not a design decision baked into components.
- **Tonal depth, not shadowed depth.** `background` → `sidebar` → `card` → `popover` is a four-step tone ladder; shadow is reserved for things that float.
- **Hairline structure.** 1px `border-border`, frequently at `/40`–`/70` opacity, is the only divider vocabulary.
- **Compact but not cramped.** Rows are 28–36px, panel headers 44px, the activity rail 40px wide.
- **One family, four sizes.** Geist Variable at 12/14/16/18px carries the entire product UI; monospace appears only where content is code.
- **Motion is state feedback only.** 150ms color transitions, 100ms overlay fades. Nothing choreographed.
- **macOS-native affordances.** Scrollbars are hidden by default, vibrancy is a first-class theme parameter, `data-tauri-drag-region` defines the title bar.

## 2. Colors

A restrained, near-monochrome instrument palette in which the only reliably saturated colors come from the terminal's ANSI ramp — which is where the meaning lives.

### Primary

- **Statement Ink** (`#E4E4E4` in Default Dark, `--primary`): In Default Dark, primary *equals* foreground — the "accent" is simply maximum contrast. In other themes it diverges sharply: Default Light uses GitHub blue (`#0969da`, `src/themes/built-in.ts:77`), Monokai lime (`#A6E22E`), Absolutely sienna (`#cc7d5e`). Applied to: filled confirm buttons, the active-project indicator, and derived highlight tints. `createCodeMirrorTheme.ts:26-30` explicitly guards against the primary-equals-foreground case by substituting a code accent — evidence that this collision is a known rough edge.
- **Primary Foreground** (`#262624`, `--primary-foreground`): Derived as the background color in dark themes, `#ffffff` in light (`src/themes/apply.ts:158`).

### Secondary

- **Recessed Panel** (`#33332F`, `--secondary`): Derives to `accent` when a theme omits it (`src/themes/apply.ts:159`). In practice `secondary` and `accent` resolve to the same value in every shipped theme, and only three files use `bg-secondary` at all (`OpenInEditorButton.tsx`, `RevealInFinderButton.tsx`, `ui/button.tsx`). Treat it as an alias, not a distinct role.

### Tertiary

Not present. `--chart-1` through `--chart-5` are defined in `types.ts:24-28`, derived in `apply.ts:169-173`, injected in `apply.ts:210-214` and re-exported in `index.css:36-40` — and referenced by **zero** UI code. They are vestigial shadcn scaffolding. Do not build on them.

### Neutral

- **Warm Graphite** (`#262624`, `--background`): The window canvas. Faded to `color-mix(..., 75%/50%/25%, transparent)` when vibrancy is subtle/medium/strong (`src/themes/apply.ts:231-236, 244-253`), letting macOS NSVisualEffect blur through.
- **Rail Graphite** (`#262624`, `--sidebar`): The second neutral layer for the activity rail, worktree sidebar, and pane headers. Derived as `color-mix(in lab, background 80%, #000000)` in dark themes and as `accent` in light themes (`src/themes/apply.ts:174`) — so light themes get a *lighter* chrome layer and dark themes a *darker* one. The only other variable that fades under vibrancy.
- **Raised Surface** (`#2D2D2B`, `--card`): Derived as background mixed 4% toward white (dark) or 3% toward black (light) (`src/themes/apply.ts:153`). Used on 17 elements — annotation cards, the diff viewer body, empty-state containers.
- **Floating Surface** (`#33332F`, `--popover`): One step brighter than card (6%/4%, `src/themes/apply.ts:155`). Every menu, dropdown, dialog, hover card, and toast.
- **Selection Tone** (`#33332F`, `--accent`): The single most-used interactive color in the app. It *is* hover, it *is* selected, it *is* the tab-pill background. Used at full strength and at `/30`, `/35`, `/50`, `/60`, `/80` opacity depending on the surface underneath.
- **Hairline** (`#3A3A37`, `--border`): The only structural line in the product. Appears at full strength on primary panel boundaries and at `/30`–`/70` for interior separation.
- **Quiet Ink** (`#898987`, `--muted-foreground`): Derived as `color-mix(in lab, foreground 55%, background)` in dark and 45% in light (`src/themes/apply.ts:162`). Carries labels, path fragments, inactive tabs, timestamps. Frequently pushed further down with `/90`, `/60`, and even `/20` opacity modifiers (`Sidebar.tsx:85`) — the low end of that range is where PRODUCT.md's "cramped low-contrast controls" anti-reference gets tested.

### Semantic State

- **Destructive** (`#E34671`, `--destructive`): Falls back to `#FC6B83`/`#cf222e` (`src/themes/apply.ts:165`). Rendered as a *tinted* button, not a filled one — `bg-destructive/10 text-destructive` (`src/components/ui/button.tsx:19`).
- **Git status** currently ships as raw Tailwind palette classes — `text-green-500`, `text-red-500`, `bg-amber-500`, `text-blue-400`, `bg-purple-500` (~100 occurrences across `Sidebar.tsx`, `CommitPanel.tsx`, `DiffView.tsx`, `PrBadge.tsx`, `AnnotationsPanel.tsx`) — **and also** as theme-derived values in the same product: `getTreesStyle()` maps added/modified/deleted/renamed to the theme's own `brightGreen`/`brightBlue`/`brightRed`/`brightYellow` (`src/themes/apply.ts:123-127`), and `DiffView.tsx:72-104` uses `var(--diffs-addition-base, #3fb950)` with a hardcoded GitHub-green fallback. **Three competing sources of truth for "added is green."**

### Terminal Ramp

Every theme carries a full 18-color ANSI set (`src/themes/types.ts:46-67`). This is not decoration: `createShikiTheme()` maps it directly onto syntax scopes — keyword→magenta, string→green, number→yellow, function→blue, type→cyan, comment→brightBlack (`src/themes/apply.ts:34-61`) — so the diff viewer, code editor, and terminal all share one color language. **The terminal palette is the real color system of this app.**

### Named Rules

**The Runtime-Color Rule.** No component may contain a color literal. Every hue reaches the DOM through `applyTheme()` (`src/themes/apply.ts:255`). A hardcoded hex or a Tailwind palette class (`green-500`, `blue-400`) is a theme bug, not a style choice.

**The Accent-Is-Interaction Rule.** `--accent` means "the user is touching or has selected this." It is never used to decorate a resting surface. Opacity modifies its intensity against different tone layers; it does not change its meaning.

**The Terminal-Is-Truth Rule.** When a UI element needs a semantic color (added, deleted, warning, branch state), it derives from `theme.terminal.*`, the way `getTreesStyle()` and `createShikiTheme()` already do. The app's own chrome may not invent a green that disagrees with the terminal's green.

## 3. Typography

**UI Font:** Geist Variable (`@fontsource-variable/geist`, imported at `src/index.css:4`; declared `--font-sans` at `src/index.css:27`)
**Heading Font:** none — `--font-heading` is aliased to `--font-sans` (`src/index.css:26`) and referenced in exactly one place (`ui/alert-dialog.tsx:120`)
**Code Font:** `ui-monospace, Menlo, Consolas, Liberation Mono, monospace` for the editor and `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace` for terminals (`src/components/settings/FontSettingSection.tsx:7-13`), both user-overridable to any installed system font

**Character:** One neutral grotesque, four sizes, two weights. Geist's tight apertures and tabular-friendly figures make it read cleanly at 12px, which is what the density demands. No display face, no pairing, no letter-spacing tricks — except one uppercase tracked treatment reserved for section labels.

### User-configurable axes

Three independent settings, all persisted in `src/store.ts:96-105`:
1. **UI font size** (`fontSize`, default 14, range 10–24) — rewrites the root `font-size`, scaling type *and* spacing *and* radius (`src/store.ts:242-245`, `src/store.ts:408`).
2. **Editor font family + size** (default monospace stack / 14px) — feeds `getDiffViewerStyle()` and CodeMirror.
3. **Terminal font family + size** (default monospace stack / 14px) — feeds xterm.

### Hierarchy

Nominal values assume a 16px root; at the shipped 14px default multiply by 0.875.

- **Headline** (600, `text-lg` = 1.125rem, 1.4): Empty-state and error headings only (`App.tsx:351`). One instance of `text-2xl` exists app-wide.
- **Title** (500–600, `text-base` = 1rem, 1.5): Dialog titles (`ui/alert-dialog.tsx:120`), a handful of settings section heads.
- **Body** (400–500, `text-sm` = 0.875rem, 1.5): **The workhorse — 143 usages.** All list rows, menu items, form fields, buttons, sidebar entries, tab labels.
- **Label** (400–500, `text-xs` = 0.75rem): 44 usages. Path fragments, counts, status text, keyboard hints, the browser URL bar's origin chip.
- **Section Label** (600, `text-sm`, `uppercase`, `tracking-[1.2px]`, at `text-muted-foreground/60`): The one deliberate typographic flourish. Marks command-palette group headings (`CommandPalette.tsx:124, 155, 185`) and the commit-panel header (`CommitPanel.tsx:477`). Settings nav uses a near-variant with `tracking-wider` (`routes/settings-layout.tsx:55, 70`).
- **Code** (monospace, 14px, 1.5): Diffs, terminals, editor, branch names, file paths, PR numbers, keyboard chords.
- **Markdown prose** (`src/index.css:119-203`): The one place with editorial typography — h1 at 2.25rem/700/`-0.025em`, h2 at 1.5rem with a `border-bottom`, body at 1.7 line-height.

Weight vocabulary is exactly two in practice: `font-medium` (73 usages) and `font-semibold` (36). `font-bold` appears 3 times, all on avatar monograms.

### Named Rules

**The One-Family Rule.** Geist for everything the user reads *about* their work; monospace for everything that *is* their work. There is no third face and no display face. A serif or a variable-width heading font anywhere in this product is a defect.

**The 14px-Root Rule.** Never hardcode a `px` font size in a component. The root is a user setting; a `px` literal opts that element out of the accessibility control. The 30 existing `text-[13px]` / `text-[10px]` / `text-[11px]` / `text-[15px]` arbitrary values are violations, not precedent.

**The text-md Trap.** `text-md` **does not exist**. Tailwind v4 defines `xs/sm/base/lg/xl/...` and neither `src/index.css` nor `shadcn/tailwind.css` defines a `--text-md` token; the class is absent from the built stylesheet. It appears in 60+ places across 10+ files (`CommandPalette.tsx` alone has 18, plus `ui/button.tsx:25`, `routes/settings-layout.tsx:30`), where it silently resolves to inherited size. Every `text-md` is an unintended type size.

## 4. Elevation

Impala is **tonal first, shadowed second**. Depth inside the window is communicated by the four-step surface ladder (`background` → `sidebar` → `card` → `popover`, each mixed 3–6% away from the last in `src/themes/apply.ts:153-155, 174`) plus 1px hairline borders. Nothing that is anchored to the layout casts a shadow. Shadow is the signal for *"this is temporarily floating above the window and will go away."*

Shadows are Tailwind v4 defaults, unmodified. There is no custom shadow token in `src/index.css`.

### Shadow Vocabulary

- **Menu lift** (`shadow-md` / `shadow-lg`): Context menus (`ui/context-menu.tsx:33`), split menus (`TabbedTerminals.tsx:654, 1025`), inline dropdowns. Paired with a 1px `border-border` — the border does the edge definition, the shadow does the separation.
- **Overlay lift** (`shadow-2xl`, sometimes `shadow-2xl shadow-black/60` plus `ring-1`): Command palette (`CommandPalette.tsx:103`), file finder, PR hover card (`PrBadge.tsx:30`), project switcher (`Sidebar.tsx:805`). These float over the entire window.
- **Ring instead of shadow**: The alert dialog uses `ring-1 ring-foreground/10` with **no** drop shadow (`ui/alert-dialog.tsx:55`) — a theme-aware hairline halo rather than a black blur. This is the more correct pattern for a themeable app.
- **Backdrop**: `bg-black/10` + `supports-backdrop-filter:backdrop-blur-xs` for dialogs (`ui/alert-dialog.tsx:33`); `bg-black/40` flat, no blur, for the command palette (`CommandPalette.tsx:100`).

### Z-Index Scale

Four levels in use, informally: `z-10` (in-pane overlays, 8 uses), `z-20` (click-outside catchers), `z-30` (inline dropdowns), `z-50` (portaled overlays — dialogs, palette, toasts, 9 uses). No arbitrary values, no `z-9999`. The scale is unnamed and undocumented in code.

### Named Rules

**The Anchored-Is-Flat Rule.** If an element has a fixed position in the layout — a panel, a header, a tab bar, a list row, a card — it gets a border, never a shadow. If it appears on top of the layout and can be dismissed, it gets a shadow.

**The Ring-Over-Black Rule.** Prefer `ring-1 ring-foreground/10` to `shadow-black/60`. A black shadow is invisible on a black theme and heavy on a light one; a foreground-derived ring works in both. Existing `shadow-black/60` and `ring-white/5` usages (`PrBadge.tsx:30`, `Sidebar.tsx:805`) predate this rule.

**The 2014 Test.** If a surface has a visible soft blur under it while sitting flush in the layout, the elevation is wrong. Delete the shadow and add a border.

## 5. Components

The blunt fact about this system: **the shared component library is four files** — `ui/button.tsx`, `ui/alert-dialog.tsx`, `ui/context-menu.tsx`, `ui/resizable.tsx`, plus `ui/sonner.tsx` as a Toaster wrapper. `ui/button.tsx` is imported by exactly one consumer (`ui/alert-dialog.tsx`). The product ships **126 raw `<button>` elements and 26 raw `<input>` elements** styled inline in feature components. There is no Input, Card, Tabs, Menu, Tooltip, Badge, Select, or Switch primitive. Everything below in "Hand-rolled patterns" is de facto convention extracted from repetition, not from a component.

### Buttons

- **Shape:** `rounded-lg` (0.625rem) at default and large sizes; `rounded-[min(var(--radius-md),12px)]` at sm and `rounded-[min(var(--radius-md),10px)]` at xs — a clamp so the radius never overwhelms a short control (`ui/button.tsx:25-32`).
- **Sizes:** `h-8` default, `h-9` lg, `h-7` sm, `h-6` xs, plus square `size-6/7/8/9` icon variants. Icons auto-size to `size-4` / `size-3.5` / `size-3` per step.
- **Primary:** `bg-primary text-primary-foreground`, hover only on anchors (`ui/button.tsx:11`).
- **Outline:** `border-border bg-background hover:bg-muted`, with a dark-mode branch to `bg-input/30` (`ui/button.tsx:13`).
- **Ghost:** `hover:bg-muted hover:text-foreground` (`ui/button.tsx:17`).
- **Destructive:** tinted, not filled — `bg-destructive/10 text-destructive hover:bg-destructive/20` (`ui/button.tsx:19`).
- **Active:** `active:not-aria-[haspopup]:translate-y-px` — a 1px press. The only tactile affordance in the system, and it is skipped for menu triggers.
- **Disabled:** `disabled:pointer-events-none disabled:opacity-50`.
- **No loading state exists** on the Button component.

**Hand-rolled button pattern (the actual majority form):** `p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent` for icon actions (`BrowserPane.tsx:330, 351, 424`), and `px-3 py-1.5 text-sm border rounded hover:bg-accent/10` for text actions in settings (`settings/GitWorktreesPane.tsx:191, 254`). Note these use bare `rounded` (Tailwind's 0.25rem), not the token scale.

### Inputs / Fields

No component exists. Two competing hand-rolled forms:

- **Bordered field:** `px-3 py-1.5 border rounded text-sm bg-background outline-none` (`FilesPanel.tsx:729`, `settings/GitWorktreesPane.tsx:191`).
- **Compact field:** `border border-border rounded px-2 py-1 text-sm outline-none` (`BrowserPane.tsx:416, 490`, `TabbedTerminals.tsx:497`).
- **Seamless field:** `bg-transparent outline-none` inside a bordered wrapper, for composed inputs with a prefix chip (`NewWorktreeDialog.tsx:331-341`) and for the command palette's `h-10` search line (`CommandPalette.tsx:114`).
- **Placeholder:** `placeholder:text-muted-foreground/90`.
- **Error / disabled:** no shared treatment. Error text renders as `text-xs text-destructive` in a bordered strip (`BrowserPane.tsx:508`).

### Tabs

Two distinct tab vocabularies coexist:

- **Tab pill** (`components/TabPill.tsx`): `px-2.5 py-1 rounded-[5px] transition-colors`, inactive `text-muted-foreground hover:text-foreground`, active `text-foreground` on `background: var(--accent)` set via an **inline style object**, not a Tailwind class (`TabPill.tsx:21`). Uses `text-md` — i.e. no explicit size.
- **Pane tab** (`TabbedTerminals.tsx:1176`): `h-9 min-w-[132px] max-w-[280px] rounded-md transition-colors`, sitting in a `h-11` header bar with `border-b border-border/70 bg-sidebar px-2` (`TabbedTerminals.tsx:1120`).
- **Settings nav** (`routes/settings-layout.tsx:84`): `px-4 py-1.5 rounded-md` in a 200px rail.

### Panels / Containers

- **Panel header:** `flex h-11 shrink-0 items-center border-b border-border/70 bg-sidebar px-2 py-1` — 44px, sidebar-toned, hairline-bottomed (`TabbedTerminals.tsx:733, 1120`). A lighter variant runs `px-3 py-2 border-b border-border` at ~32px for narrow panels (`AnnotationsPanel.tsx:108`, `FileViewer.tsx:281`).
- **Activity rail:** `flex flex-col items-center h-full w-10 bg-sidebar border-r border-border py-2.5 gap-1`, with 28px (`w-7 h-7`) targets and `rounded-[5px]`/`rounded-[6px]` corners (`Sidebar.tsx:228, 257-305`).
- **Cards:** only used for content chunks (annotations, empty states), `bg-card` + `border-border` + `rounded-lg`. Never nested, never in a grid.
- **Grouped nav block:** `mx-2.5 mt-2.5 mb-2 flex flex-col gap-0.5 rounded-lg bg-accent/35 p-1` (`Sidebar.tsx:745`) — a tinted well rather than a bordered card.
- **Resize handle:** a 1px `bg-border` separator with a 4px invisible hit area via `after:` (`ui/resizable.tsx:37`), plus an optional 24×4px grab pill.

### List Rows

The single most repeated pattern in the app: `flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer` with `hover:bg-accent` and selection via `data-[selected=true]:bg-[var(--color-editor-selection)]` (`CommandPalette.tsx:132`, `FileFinder.tsx:235`) or `hover:bg-accent/30` in denser panels (`AnnotationsPanel.tsx:190`). Row height lands at 28–32px. Sidebar file-tree rows are squared off deliberately — `--trees-border-radius-override: 0px` and zero inline padding so the highlight spans the full rail width (`src/themes/apply.ts:129-133`).

### Menus / Popovers

`bg-popover text-popover-foreground border border-border rounded-md shadow-md py-1 min-w-[140px] text-sm outline-none`, items at `px-3 py-1.5` with `data-highlighted:bg-accent` (`ui/context-menu.tsx:32-45`). Hand-rolled menus repeat this near-verbatim at `min-w-[160px]` / `min-w-[180px]` (`TabbedTerminals.tsx:654, 1025`).

### Dialogs

`fixed top-1/2 left-1/2 -translate-1/2 grid gap-4 rounded-xl bg-popover p-4 ring-1 ring-foreground/10`, capped at `max-w-xs` / `sm:max-w-sm`. Footer is a full-bleed `bg-muted/50` strip with `border-t`, achieved via negative margins (`ui/alert-dialog.tsx:55, 88`). Buttons reverse on mobile (`flex-col-reverse sm:flex-row`).

### Signature Component: The Command Palette

`CommandPalette.tsx` is the clearest statement of the system: a `max-w-[640px]` sheet at `top-[20%]`, `rounded-xl border border-border bg-popover shadow-2xl`, a borderless `h-10` search line with a 14px inline SVG icon, a `max-h-[400px] p-1.5` scroll list, and uppercase tracked group headings at `muted-foreground/60`. Every row is 28px with a 12px icon, a label, and a right-aligned keyboard chord. It is keyboard-first, monochrome, and uses `primary` only to mark the active worktree.

### Motion

Motion is state feedback and nothing else. There are no entrance animations, no scroll effects, no page-load choreography.

- **Color transitions** (`transition-colors`, 51 usages, Tailwind default 150ms): the universal hover/active response.
- **Opacity transitions** (`transition-opacity`, 7 usages): reveal-on-hover affordances such as the markdown code-block copy button (`markdownComponents.tsx:78`).
- **Overlay enter/exit** via `tw-animate-css` (`src/index.css:2`): `data-open:animate-in fade-in-0 zoom-in-95` / `data-closed:animate-out fade-out-0 zoom-out-95` at `duration-100`. Used in exactly three files — `ui/alert-dialog.tsx:33, 55`, `ui/context-menu.tsx:34`, `RunActionsButton.tsx:95-96`. Hand-rolled menus and the command palette have **no** enter/exit animation.
- **Status pulses** (`animate-pulse`, 7 usages): agent-running dots in the activity rail (`Sidebar.tsx:312`), the browser "loading" chip (`BrowserPane.tsx:461`).
- **Annotation flash** (`src/index.css:205-212`): the only custom keyframe — a 1.5s `ease-out` primary-tinted background fade to locate a jumped-to annotation.
- **Button press**: `active:translate-y-px`.
- **Not animated:** panel resize, tab switching, sidebar collapse, list reordering, diff expansion.
- **`prefers-reduced-motion` appears nowhere in `src/`.** The only reduced-motion guard in the bundle is the one shipped inside `shadcn/tailwind.css` for its shimmer utility. PRODUCT.md asks for "reduced-motion-friendly state changes"; the codebase does not yet honor it.

### Scrollbars

Global `scrollbar-width: none` and `::-webkit-scrollbar { display: none }` on everything (`src/index.css:73-79`). A `.show-scrollbar` opt-in restores a 14px track with a 7px `--border` thumb inset by a 4px transparent border, brightening to `--muted-foreground` on hover (`src/index.css:80-101`).

## 6. Do's and Don'ts

### Do:

- **Do** route every color through the theme layer. Add the token to `ThemeUI` (`src/themes/types.ts`), derive it in `resolveTheme()` (`src/themes/apply.ts:143`), map it in `CSS_VAR_MAP` (`src/themes/apply.ts:191`), and expose it in `@theme inline` (`src/index.css:25`). Then use it as a Tailwind class.
- **Do** derive semantic status colors from `theme.terminal.*`, the way `getTreesStyle()` does for git status (`src/themes/apply.ts:123-127`).
- **Do** use `text-sm` as the default UI size and `text-xs` for labels. Those two carry 187 of the ~230 sized elements in the app.
- **Do** express depth with the tone ladder (`bg-background` → `bg-sidebar` → `bg-card` → `bg-popover`) plus `border-border`.
- **Do** use `--accent` for every hover and selected state, and modify intensity with opacity (`/30`, `/60`, `/80`) rather than by picking a different color.
- **Do** keep panel headers at `h-11` with `border-b border-border/70 bg-sidebar`, list rows at `px-2 py-1.5 rounded-md`, and icon buttons at 28px (`w-7 h-7`).
- **Do** pair `data-open:animate-in`/`data-closed:animate-out` at `duration-100` with every portaled overlay, so dismissal is not instantaneous.
- **Do** provide a non-color cue for selected state alongside the accent background — PRODUCT.md requires "non-color cues for selected state."
- **Do** reuse `ui/button.tsx` and `ui/context-menu.tsx` instead of hand-rolling the 127th `<button>`.

### Don't:

- **Don't** write a hex literal, an `oklch()` literal, or a Tailwind palette class (`bg-green-500`, `text-blue-400`, `bg-amber-500`, `text-purple-400`) in any component. These do not respond to the user's theme and break every theme except the one they were eyeballed against. ~100 such usages exist today across `Sidebar.tsx`, `CommitPanel.tsx`, `DiffView.tsx`, `PrBadge.tsx`, `AnnotationsPanel.tsx`, and the settings panes; treat all of them as debt, not precedent.
- **Don't** use `text-md`. It is not a real class in this stylesheet. Pick `text-sm` (which is what most `text-md` sites intended) or `text-base`.
- **Don't** hardcode `text-[13px]`, `text-[10px]`, `text-[11px]`, `text-[15px]` or any arbitrary `px` type size. It opts the element out of the user's UI-font-size setting.
- **Don't** ship *cramped low-contrast controls* or *tiny labels* (PRODUCT.md anti-references). `text-muted-foreground/20` (`Sidebar.tsx:85`), `/60` on section labels, and 10px type are the exact failure this product names. Body text must clear 4.5:1 against its surface in every shipped theme, including Default Light.
- **Don't** add *ornamental dashboard styling* (PRODUCT.md). No stat tiles, no hero metrics, no gradient accents, no identical card grids, no decorative icon chrome.
- **Don't** introduce *unfamiliar interaction patterns* (PRODUCT.md). Use the tab bar, the context menu, the command palette, and the resizable split that already exist.
- **Don't** *trade readability for density* or *let secondary chrome compete with the working content* (PRODUCT.md). The rail, headers and tab bars stay at `sidebar` tone with `muted-foreground` labels; the diff and terminal own the contrast budget.
- **Don't** put a drop shadow on anything anchored in the layout. Border only. And never `border-left` or `border-right` greater than 1px as a colored accent stripe.
- **Don't** use `shadow-black/60` or `ring-white/5`; both assume a dark theme. Use `ring-1 ring-foreground/10`.
- **Don't** hardcode `theme="dark"` on themed third-party components. `ui/sonner.tsx:7` currently does, so toasts render dark under Default Light.
- **Don't** build on `--chart-1`…`--chart-5`, `--highlight-match`, `--highlight-active`, `--color-link`, or `--color-code-background`. All six are injected by `applyTheme()` and consumed by nothing. They are vestigial.
- **Don't** add motion that does not report a state change. No entrance choreography, no scroll-driven reveals, no orchestrated page loads — and if you add motion at all, ship a `prefers-reduced-motion: reduce` alternative, which currently exists nowhere in `src/`.
- **Don't** use `rounded` (bare, 0.25rem) or arbitrary `rounded-[5px]` / `rounded-[6px]` / `rounded-[3px]` for new work. Use the `--radius`-derived scale: `rounded-sm`/`md`/`lg`/`xl`. The 11 arbitrary-radius sites are inconsistency, not a system.
- **Don't** set colors via inline `style` when a Tailwind token exists. `TabPill.tsx:21` sets `background: var(--accent)` inline where `bg-accent` would do; that pattern hides theming from the class scanner.
