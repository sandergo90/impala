# Splittable tabs in the terminal panel

## Goal

Every tab inside the terminal panel — agent, terminal, browser, file — can be split into
resizable panes, and the user chooses what fills the new pane: a new agent, a terminal, a
browser, or a file. E.g. from the main agent tab, split right into a second agent or a
browser. This replaces the need for the unused top-level Split mode.

## Where we start from

There are already three split systems in the codebase:

1. **Per-user-tab split tree** (`UserTab.splitTree: SplitNode` + inline `SplitNodeRenderer`
   in `TabbedTerminals.tsx:773`) — works today, but leaves are hardcoded to
   `paneType: "agent" | "shell"`, splitting always creates a shell
   (`split-tree.ts:40`), and the ⌘D gating in `App.tsx` only enables it for
   terminal/agent user tabs. File and browser tabs branch out early in
   `TabbedTerminals.tsx:527-535` and never reach the split renderer.
2. **General-terminal split** (`SplitTreeRenderer.tsx`) — a second, near-duplicate renderer
   used only for the no-worktree general terminal.
3. **Top-level Split mode** (`activeTab: "split"` in `MainView.tsx:367`) — fixed
   agent | diff/browser two-pane layout. Unused in practice.

The design below generalizes system 1, folds system 2 into the same renderer, and leaves
system 3 untouched (removal is a separate cleanup once this ships).

## Core design: content-bearing leaves

Generalize the `SplitNode` leaf so the tree describes *what* is in each pane, not just
terminals:

```ts
// types.ts
export type PaneContent =
  | { kind: "agent" }
  | { kind: "shell" }
  | { kind: "file"; path: string }
  | { kind: "browser"; url?: string };

export type SplitNode =
  | { type: "leaf"; id: string; content: PaneContent }
  | { type: "split"; orientation: "horizontal" | "vertical"; ratio: number; first: SplitNode; second: SplitNode };
```

Every user tab always has a `splitTree` (single leaf in the common case) and a
`focusedPaneId`. The renderer in `TabbedTerminals` loses its early `FileViewer` /
`BrowserPane` branches: every tab body is rendered by one recursive tree renderer whose
leaf switch dispatches on `content.kind`:

- `agent` / `shell` → `TabBody` (existing, already per-paneId)
- `file` → `FileViewer` (must become prop-driven, see below)
- `browser` → `BrowserPane` (must become per-pane, see below)

### Identity and session continuity

Leaf ids are the pane ids everything else derives from:

- PTY session id stays derived from paneId (`pane-ids.ts`), so **migrated single-leaf
  terminal tabs must keep leaf id = `tab-user-${tabId}`** — existing daemon PTY sessions
  reattach untouched. Split-created leaves keep the `pane-${ts}-${n}` scheme.
- Browser webview label becomes `browser-{leafId}` instead of `browser-{tabId}`
  (`browser.rs:label_for`). Webviews don't survive app restart, and migration only runs at
  rehydrate, so the label change is invisible in practice.

### `UserTab` fields: single source of truth

`content` in the leaves becomes the source of truth for what a pane shows. `UserTab`
keeps:

- `kind` — the tab's identity for the tab strip (icon, label defaults, url-dedupe in
  `createBrowserTab`, preview/pin semantics in `openFileTab`). Defined as the content of
  the tab's *primary leaf* (the `tab-user-${id}` one).
- `path` / `url` — kept as mirrors of the primary leaf's content so the tab strip and
  dedupe logic don't change. **All writes go through `tab-actions.ts`** (the existing
  single write path), which updates leaf + mirror together. `openFileTab`'s
  preview-replacement updates the primary leaf's `path`; `BrowserPane` nav events update
  the leaf's `url` (and the mirror when it's the primary leaf).

### Migration (persist v7)

`useUIStore` persist version 6 → 7. For each `UserTab` in every `worktreeNavStates`
entry:

- `kind: "terminal" | "agent"` with existing `splitTree` → map each leaf's `paneType` to
  `content: {kind}`; without one → single leaf `{ id: userTabPaneId(tab.id), content: {kind: "shell"|"agent"} }`.
- `kind: "file"` → single leaf `{ id: userTabPaneId(tab.id), content: {kind: "file", path} }`.
- `kind: "browser"` → single leaf `{ id: userTabPaneId(tab.id), content: {kind: "browser", url} }`.
- `focusedPaneId` defaults to the primary leaf.

`getEffectiveUserTabSplitTree` / `getEffectiveUserTabFocusedPaneId` (`tab-actions.ts:20`)
stay as belt-and-braces for any tab that slips through without a tree.

### The Agent system tab

The agent tab is the most-used tab and "agent + shell side by side" is the headline use
case, so it must be splittable too. It's synthesized (no `UserTab` record), so its split
state lives in `WorktreeNavState`:

```ts
agentTabSplitTree?: SplitNode;      // root leaf id = AGENT_PANE_ID, content {kind:"agent"}
agentTabFocusedPaneId?: string;
```

Persisted like userTabs. The Run tab stays unsplittable (it's a managed script output).

## Renderer: one component, one leaf-renderer prop

Extract the inline `SplitNodeRenderer` from `TabbedTerminals.tsx` into a single shared
`SplitTreeRenderer` component:

```ts
<SplitTreeRenderer
  tree={tree}
  focusedPaneId={focusedPaneId}
  onFocusPane={...}
  onRatioChange={...}
  renderLeaf={(leaf, isFocused) => ...}
/>
```

Consumers: every user tab, the agent system tab, and the general terminal (whose current
standalone `SplitTreeRenderer.tsx` LeafPane becomes just its `renderLeaf`). The
orientation-inversion quirk (divider direction vs. panel-group direction) lives in one
place. Keep the existing focus behavior: `onMouseDownCapture` focuses the pane; unfocused
panes dim to 0.6 opacity — **DOM panes only**; a native browser webview ignores DOM
opacity, so browser panes show focus via toolbar styling instead.

### Ratio persistence

rrp v4 exposes `onLayoutChanged` on `Group` (no debouncing needed per its docs). Wire it
to `updateRatio` → store, so divider drags finally persist. This also fixes the existing
latent bug where drag-resizes are lost on tab switch/restart.

## Per-kind pane work

### Terminal / agent — mostly nothing new
`TabBody` already takes a paneId and lazy-spawns per-pane PTYs; the xterm keep-alive cache
and daemon reattach are pane-scoped already. New **agent leaves** (splitting in a second
agent) reuse the same launch path user tabs of `kind: "agent"` use today
(`prepare_agent_config` / `prepare_shell_launch` per pane) — the launch-once guard must be
per pane session, not the nav-state `agentLaunched` flag reserved for the primary agent.

### File — make `FileViewer` prop-driven
Today `FileViewer` takes no props and derives the file from
`selectedWorktree` + `activeTerminalsTab`, so only one instance can exist. Change it to
accept `{ worktreePath, path }` and move the "which file" decision to the leaf. Buffers
already live in the pane-agnostic `editor-docs` store + `editor-buffer-registry`
(keyed by worktreePath+path), so backgrounding/restore keeps working.

**Edge to verify in phase 3:** two panes showing the *same* file means two CodeMirror
views over one registry buffer. If `CodeEditor` can't cleanly share, v1 guard: reject
opening a file into a split when another pane in the same tab already shows it.

### Browser — per-pane webviews
`BrowserPane` keys its native child webview by tab id today; change to the leaf id
(prop `paneId`). Everything else already works per-instance:

- Bounds: the placeholder `ResizeObserver` + rAF sync follows panel resizes live.
- Occlusion: `visible = tabActive && worktreeActive && !palette && !finder && !dragActive`,
  threaded per pane. Multiple webviews visible at once (two browser panes side by side)
  is fine — each parks/positions independently.
- **Split-handle drags must park webviews**: pointer events over a native webview would
  swallow the divider drag. Reuse MainView's `panelDragActive` pattern
  (`MainView.tsx:55-64`): `pointerdown` on any `ResizableHandle` inside the shared
  renderer sets the flag, `pointerup`/`pointercancel` clears it. Put this *in*
  `SplitTreeRenderer` so every consumer gets it.
- Tab close must `browser_close` every browser leaf, not just `browser-{tabId}`
  (`closeUserTab` in `tab-actions.ts:158`); pane close closes just that leaf's webview.

## Split / close / focus semantics

- **Splitting takes explicit content**: `splitNode(tree, targetId, orientation, content)`
  — the caller says what fills the new pane. Three entry points:
  - **⌘D / ⇧⌘D** stay the fast path and create a **shell** (current behavior, no chooser
    in the way).
  - **Split menu** — a small split button with dropdown on the pane (or tab strip):
    "Split right/down with → Agent / Terminal / Browser / File…". Agent launches a fresh
    agent in the new pane; Browser opens the empty-state browser pane (user types the
    URL); File opens the file finder targeting the new pane.
  - **Command palette** — the same entries, keyboard-reachable.
- **⌘W** closes the focused pane; disposal per kind (kill PTY / `browser_close` / no-op
  for file). Last pane in the tree = close the tab (existing `removeNode` returns null at
  root). Existing `closeUserTabFocusedPane` generalizes.
- **⌘] / ⌘[** cycle panes — unchanged (`getAdjacentLeafId`).
- **Gating** (`App.tsx` `splitEnabled`): drop the "must be a terminal/agent user tab"
  restriction → enabled whenever `activeTab === "terminal"` and the active terminals tab
  is the agent tab or any user tab.
- Focus sources: xterm focus (terminal), editor focus / mousedown (file), toolbar or
  placeholder mousedown (browser). All funnel into `setUserTabFocusedPane`.

## Phases

Each phase ships independently and keeps the app working.

**Phase 1 — extract the shared renderer (no behavior change)**
Pull the inline `SplitNodeRenderer` out of `TabbedTerminals.tsx` into the shared
`SplitTreeRenderer` with a `renderLeaf` prop; port the general terminal onto it; add the
`panelDragActive` handle-drag bracketing and `onLayoutChanged` ratio write-back here.
→ verify: existing terminal-tab splits and the general terminal behave identically;
divider drags now persist; typecheck.

**Phase 2 — content-bearing leaves + migration v7**
New `PaneContent` union; migrate persisted state; `tab-actions` split/close/focus
generalized; file/browser tabs render through the tree (still single-leaf);
`FileViewer` becomes prop-driven; `BrowserPane` keyed by paneId.
→ verify: launch with a v6 localStorage snapshot — PTY sessions reattach, browser tabs
restore their URL, file tabs open, preview/pin semantics still work; typecheck.

**Phase 3 — enable splitting everywhere, with content choice**
Gating update in `App.tsx`; agent-tab split state in `WorktreeNavState`; `splitNode`
takes a `PaneContent`; split menu + command-palette entries for Agent / Terminal /
Browser; per-kind pane disposal on close; browser-pane focus styling.
→ verify (live app): split agent tab → second agent launches in the new pane; split with
browser → page + agent side by side, divider drag parks/restores the webview, both
webviews visible when two browser panes coexist; ⌘D still gives a quick shell; ⌘W
pane-close and last-pane tab-close; restart restores every layout including the second
agent's PTY.

**Phase 4 — polish (optional)**
"Split with file…" (finder targeting a pane) and "Duplicate pane"; same-file-twice
support or guard; retire the top-level Split mode (`activeTab: "split"`,
`splitRightPane`) with a migration once per-tab splits cover its use.

**Phase 5 — tabs inside panes (editor-group model, gated)**

Today's model is one level deep: top-level tabs → split tree → one content per pane. A
pane cannot hold multiple tabs (e.g. two browsers stacked as tabs in the right pane while
the agent stays left). Phase 5 adds that, in two stages — **do not start until per-tab
splits have been lived with**; the trigger is repeatedly wanting several things stacked
in one pane region.

*Architectural decision (made now so 5a/5b don't fight it): keep the top-level tab strip
and system tabs exactly as they are.* Groups nest **inside** tabs
(tab → splits → tab groups), rather than flattening the whole panel into one split tree
of groups (pure VS Code model). Flattening would relocate the Agent/Run system tabs and
rework the entire strip for marginal gain.

**5a — cheap reorganization (no new UI surfaces)**
Panes are content-addressed, so these are pure tree operations + palette commands:
- "Move pane to new tab" — extract the focused pane's leaf into a fresh `UserTab`,
  sibling takes its place (existing `removeNode`).
- "Merge tab into pane" — take another tab's primary content and split it into the
  focused pane, closing the source tab.
Identity is preserved by carrying leaf/pane ids across, so PTYs, webviews, and editor
buffers survive the move untouched.

**5b — real tab groups**
- Model: the `leaf` node generalizes to a group —
  `{ type: "group"; id: string; tabs: GroupTab[]; activeTabId: string }` with
  `GroupTab = { id; label; content: PaneContent; createdAt; pinned? }`. Group tabs hold
  flat `PaneContent`, never a nested split tree — no infinite nesting.
- Migration v8 (mechanical): wrap every leaf `{id, content}` into a single-tab group
  reusing the leaf id as the tab id — PTY session ids, webview labels, and buffer keys
  all unchanged.
- Rendering: a group renders a mini tab strip **only when it holds ≥ 2 tabs** (single-tab
  groups look exactly like today's panes — progressive disclosure). Inactive group tabs
  unmount; the existing keep-alive layers (xterm cache, parked webviews, editor-docs
  registry) already handle that by id.
- Browser occlusion gains one condition: a webview is visible only when its group tab is
  active *and* the group's pane is visible.
- Focus: `focusedPaneId` keeps pointing at the group; `activeTabId` selects within it.
  ⌘W closes the active tab in the focused group → last tab closes the group (sibling
  takes its place) → last group closes the top-level tab (Agent tab still never closes).
- Stretch: dragging tabs between groups (dnd-kit cross-container) — expected once strips
  exist, but ship 5b without it first.
- Carry-over: tree algebra, shared renderer, ratio persistence, drag parking, and
  per-pane identity all survive unchanged; only the leaf case of the renderer and the
  leaf-targeting tree ops (`splitNode`, `removeNode`, `findLeaf`, dispose) learn about
  groups.

→ verify (5b): migrate v7 → v8 losslessly; stack two browsers in one group and switch
between them (webview park/restore); ⌘W cascade tab → group → top-level tab; restart
restores groups, active tabs, and reattaches every PTY.

## Risks / open edges

- **Same file in two panes** (phase 3 verify): CodeMirror multi-view over one shared
  buffer — verify or guard.
- **Webview memory**: each browser pane is a WKWebView. No cap in v1; revisit if users
  stack many.
- **MCP browser tools** resolve "the worktree's browser" via `BrowserRegistry`; multiple
  browser panes make that ambiguous — but multiple browser *tabs* already do, so behavior
  is unchanged (first/registered wins).
- **Migration is one-way**: keep the v6→v7 migration total (no data loss for unknown
  fields) since localStorage has no backup.
