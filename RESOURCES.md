# Codex app-server resources

## Knowledge

- [Codex app-server protocol README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  Primary protocol reference for initialization, threads, turns, items, approvals, and notifications. Use for every wire-level Impala decision.
- [Codex app-server daemon README](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)
  Primary lifecycle reference for the managed daemon, control socket, remote control, startup, restart, and shutdown behavior.
- [Codex app-server transport source](https://github.com/openai/codex/tree/main/codex-rs/app-server-transport)
  Source of truth when transport framing or the Unix control-socket behavior is unclear.
- [Codex CLI source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs)
  Source of truth for current `app-server daemon`, `remote-control`, and TUI remote-connection commands.

## Wisdom (Communities)

- [OpenAI Codex GitHub issues](https://github.com/openai/codex/issues)
  Maintainer and practitioner discussion about real integration failures and protocol changes. Use to test assumptions not settled by the reference docs.

## Gaps

- The public docs do not yet present an end-to-end example of two simultaneous clients controlling and rendering one thread.
- Experimental queue semantics need version-specific verification before Impala treats them as a stable delivery primitive.
