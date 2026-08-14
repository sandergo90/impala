# Mission: Codex app-server integration for Impala

## Why
Design and review an Impala integration that can address Codex threads directly, wake an orchestrator after delegated work completes, and preserve the terminal experience without fragile PTY input injection.

## Success looks like
- Explain which state belongs to the app server, the TUI, and Impala.
- Choose correctly between starting, steering, and queueing a turn.
- Review daemon lifecycle, thread identity, retry, and deduplication decisions.
- Trace a delegated-agent completion from Impala back into the originating Codex thread.

## Constraints
- Use current OpenAI primary sources because the protocol is experimental and version-sensitive.
- Keep lessons short and tied to concrete Impala architecture decisions.
- Preserve PTY behavior until structured transport parity is proven.

## Out of scope
- Reimplementing the Codex app server.
- Covering every protocol method before it affects an Impala decision.
- General JSON-RPC instruction beyond what this integration needs.
