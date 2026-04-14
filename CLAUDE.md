# Karpathy Rules

The spirit: **less code, more clarity**. Every line is a liability. Every
abstraction must earn its existence. Read everything you generate.

---

## 1. Less is more

- The best change is the one that deletes code.
- Prefer 20 obvious lines over 5 clever ones built on three helpers.
- If a feature can be cut from scope, cut it. Ship the smallest thing that
  proves the idea.
- A diff that adds 400 lines for a one-line behaviour change is a smell, not
  a victory.

## 2. Don't add what wasn't asked

- No bonus features, no "while I was here" refactors, no speculative
  extension points.
- No new dependencies unless the task genuinely requires one. Reach for the
  standard library and existing project utilities first.
- No new files when an existing one fits. No new packages when an existing
  one fits.
- If you find yourself adding a config flag "in case", delete it.

## 3. Don't defend against impossible states

- No try/catch around code that cannot throw. No null checks for values the
  type system already guarantees. No validation at internal boundaries.
- Validate at the edges (user input, network, disk, third-party APIs) and
  trust the inside.
- Do not invent fallbacks for branches that will never run. Dead code rots.

## 4. Inline before you abstract

- Three similar lines beat a premature helper. Wait for the third or fourth
  real caller before extracting.
- A function used in exactly one place usually belongs inlined at the call
  site, unless naming it genuinely clarifies intent.
- Resist class hierarchies, generic wrappers, and "framework" code for one-
  off problems.

## 5. Explicit over implicit

- Prefer obvious data flow over clever indirection (decorators, metaclasses,
  dynamic dispatch, "magic" registries).
- A reader should be able to follow a request from entry point to exit
  without grepping for hidden hooks.
- Boring code wins. Surprise is a defect.

## 6. Readable beats clever

- Names should describe the thing, not its implementation. `users` over
  `userArray`, `parseInvoice` over `processData`.
- Short functions, short files, short call chains. If a function does not
  fit on a screen, it is doing too much.
- A junior should be able to read the code top-to-bottom and understand it
  without a guided tour.

## 7. Comments are a last resort

- Default to zero comments. Code should explain _what_; comments only when
  _why_ is non-obvious.
- Never restate the code in English. Never narrate the diff. Never reference
  the ticket.
- Remove stale comments on sight. A wrong comment is worse than none.

## 8. No premature performance, no premature scale

- Write the simple version first. Measure before optimising. Most code is
  not hot.
- Do not introduce caches, queues, batching, or pools until you have a
  profile that justifies them.
- "It might be slow one day" is not a requirement.

## 9. Tests where they matter

- Test the behaviour that would actually break in production: the edges,
  the contracts, the bugs you have already hit.
- Do not write tests that mirror the implementation line-for-line — they
  pin the wrong thing and break on every refactor.
- An integration test that exercises the real path beats ten mocked unit
  tests of glue code.

## 10. Read what the LLM writes

- The hottest new programming language is English — but the compiler still
  hallucinates. Audit every generated line as if a junior wrote it on a
  Friday afternoon.
- Run it. Read the diff. Trace one real input through the new code by hand.
  "It compiles" and "the test passed" are not understanding.
- If you cannot explain _why_ a line is there, it should not be there.

## 11. Vibe code in throwaways, not in production

- Exploratory scripts and prototypes can move fast and skip rigour — that
  is their job.
- Anything that ships to users gets the full treatment: read, test, review,
  measure.
- Be honest about which mode you are in, and never let prototype code drift
  into production without a rewrite.

## 12. Delete aggressively

- Unused code, dead branches, commented-out blocks, "just in case" exports —
  all gone. `git` remembers everything; the working tree should not.
- Removing a feature is a feature. A smaller surface area is a gift to
  every future reader.
