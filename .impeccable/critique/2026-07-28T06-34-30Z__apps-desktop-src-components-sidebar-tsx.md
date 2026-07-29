---
target: the Impala sidebar (Sidebar.tsx)
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
timestamp: 2026-07-28T06-34-30Z
slug: apps-desktop-src-components-sidebar-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Rich status, but nearly all color-only dots with no text channel |
| 2 | Match System / Real World | 2 | "Automations" means two different things two blocks apart |
| 3 | User Control and Freedom | 3 | Good confirms/escapes; no undo after optimistic worktree delete |
| 4 | Consistency and Standards | 2 | Nav card and tab track are pixel-identical containers with different semantics |
| 5 | Error Prevention | 3 | Good delete dialog; hover × materializes over the diff stats being read |
| 6 | Recognition Rather Than Recall | 2 | User must recall which "Automations" navigates vs filters; badge lives in two homes |
| 7 | Flexibility and Efficiency | 2 | No arrow-key list traversal; Search replays hardcoded ⌘P vs displayed ⌘⇧P |
| 8 | Aesthetic and Minimalist Design | 2 | Five equal-weight chrome blocks before the first content row |
| 9 | Error Recovery | 3 | Optimistic rollback works; raw backend strings leak into toasts |
| 10 | Help and Documentation | 3 | kbd hints and tooltips; adequate for Operate |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict

Split: the worktree list is genuinely authored (agent-status dots, PR/issue chips, attention-driven auto-open groups — no other product's sidebar looks like this). The chrome above it is category-interchangeable: five rounded containers of near-identical tone/width/radius (nav card, switcher, search pill, tab track, New Worktree) stacked with no dominant element — the Linear/Raycast idiom. Against the "Instrument Panel" north star (chrome may never outweigh content), the frame currently has five visual events and the content one.

Deterministic scan: 4 advisory findings, all hardcoded badge font sizes off the documented type ramp (`text-[11px]` at Sidebar.tsx:212/935/1320, `text-[9px]` in RunningServicesMenu.tsx:210) — true positives per DESIGN.md's own 14px-root rule, part of a documented 30-violation backlog. No color-token violations; AutomationsView.tsx clean. Browser overlay skipped (no browser automation available).

## Priority Issues

- **[P0] Keyboard focus is invisible sidebar-wide.** `index.css` kills `*:focus` outlines globally and nothing here defines `focus-visible`. Violates WCAG 2.4.7 and the brief's "keyboard-first" principle. Fix: shared `focus-visible:ring-2 ring-ring` on the interactive primitives; scope the global reset to `:focus:not(:focus-visible)`.
- **[P1] "Automations" appears twice with different meanings, with duplicate badges.** Nav row navigates to /automations; tab filters the list; both carry the unreviewed count. Largest comprehension tax in the panel. Fix: rename the tab pair to the population ("Branches / Runs" — internal key is already `"branches"`), keep the badge in exactly one home (the tab).
- **[P1] Chrome outweighs content; no hierarchy among the five stacked blocks.** Nav card, switcher, search, tab track, New Worktree — equal weight, and the nav card + tab track are visually identical containers with different semantics. Fix: flatten nav rows to bare buttons, demote search to an icon/footer affordance, leave the tab track as the only filled container.
- **[P2] Hover swap hides diff stats under a span-based delete ×.** Stats get `group-hover:invisible`; the × is an unfocusable span with no role/label. Fix: keep stats visible; real button beside them, shown on hover and focus-within.
- **[P2] Search pill dispatches a synthetic hardcoded ⌘P while displaying the configurable ⌘⇧P binding.** Call an exported palette action instead.
- **[P3] ARIA is toggle-shaped where it should be nav/tab-shaped.** `aria-pressed` on navigation; segmented control lacks tablist semantics and arrow keys; project dropdown lacks menu role/roving focus.

## Persona Red Flags

**Alex (power user):** no Up/Down traversal for the most frequent action (switch worktree); "+ New Worktree" hides on the Automations tab while ⌘N stays live; delete hotkey on main silently no-ops; the diff stats he ranks rows by vanish under his cursor on hover; Search click may do nothing if the palette wants ⌘⇧P.

**Sam (keyboard/AT):** cannot establish position at all (P0); "working" / "unseen" / "permission" states are color-only dots with no text alternative; rename is pointer-context-menu-only; group badges explain themselves only via `title` tooltips; delete × unreachable (dialog + hotkey are the one accessible path).

## Minor Observations

- Tab key `"branches"` vs label "Worktrees" — code and UI disagree; the code is honest.
- "Worktrees" section header disappears the day the first automation runs (only rendered when no automation rows).
- Hand-drawn BranchIcon at stroke 1.4 beside lucide at stroke 2 — two icon weights.
- `+27559 −6733` unformatted five-digit mono figures shout in a 320px rail; compact to `27.5k`, add `tabular-nums`.
- Meaning-bearing text hides in `title` tooltips (badges); invisible to touch/AT.
- Nav card renders as a one-item "group" when no project is selected.

## Questions to Consider

1. If the command palette is the true fast path, why does the sidebar carry a switcher, a search pill, and a New button at all? The most instrument-panel-faithful version might be: list, one tab track, one footer.
2. Should automation-run worktrees live in the sidebar at all, given AutomationsView already owns these objects? The label collision is a symptom; split ownership is the disease.
3. Is "active location unmistakable" achievable with hairline rings on accent≈sidebar fills, or does the default theme need one deliberate exception?
