# Research: moving Impala's agent sessions to ACP

Status: research, no decision made. Written 2026-08-14.

Question: today Impala runs Claude Code and Codex as CLIs inside a PTY and renders them
with xterm. Should we drive them over the **Agent Client Protocol (ACP)** instead, so the
app owns the UI?

Short answer: yes, but not as a replacement for the terminal — as a **second session
renderer** behind a provider abstraction we don't have yet. The abstraction is the real
work; ACP is the easy part.

---

## 1. What ACP is, as of August 2026

ACP standardises the editor↔agent boundary the way LSP standardised the editor↔language
boundary. JSON-RPC 2.0 over stdio (the client spawns the agent as a subprocess); HTTP/SSE
and WebSocket transports exist for remote agents. Governed openly by Zed, JetBrains and
Anthropic.

**The protocol surface we'd care about:**

| Direction | Method | Purpose |
| --- | --- | --- |
| client → agent | `initialize` | version + capability negotiation |
| client → agent | `authenticate` | when the agent reports it needs auth |
| client → agent | `session/new` | takes `cwd` **and `mcpServers`** → returns `sessionId` |
| client → agent | `session/load` | replays a prior session as `session/update` notifications |
| client → agent | `session/prompt` | one turn; resolves with a `stopReason` |
| client → agent | `session/cancel` | interrupt |
| client → agent | `session/set_mode` | plan / edit / ask modes |
| agent → client | `session/update` | **the stream: everything the UI renders** |
| agent → client | `session/request_permission` | approval prompts |
| agent → client | `fs/read_text_file`, `fs/write_text_file` | agent asks *us* to touch the disk |
| agent → client | `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | agent asks *us* to run commands |

`session/update` variants: `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`,
`tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`,
`usage_update`.

Tool calls carry `toolCallId`, `title`, `kind` (`read | edit | delete | move | search |
execute | think | fetch | other`), `status` (`pending | in_progress | completed | failed`),
`locations` (absolute path + optional line — this is what powers "follow the agent through
the files"), and `content` which is one of plain content, a **structured diff**
(`path`/`oldText`/`newText`), or a **terminal handle** for streaming output.

Stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.

### Version state — important

- **Protocol v1 is stable. Protocol v2 is draft.** The migration guide explicitly says new
  implementers should target v1 and gate v2 behind version negotiation until it stabilises.
- v2 is a meaningful redesign, not a rename: `session/prompt` becomes a fire-and-forget ack
  with a new `state_update` notification carrying `running | idle | requires_action`;
  messages get agent-generated `messageId`s and upsert semantics; **`fs/*` and `terminal/*`
  are removed entirely** (agents are expected to expose those through MCP instead), replaced
  by an agent-owned display-only terminal.
- Practical read: build against v1, keep the mapping layer between "ACP wire types" and
  "Impala's session model" thin enough that v2 is a rewrite of one file, not of the UI.

### The registry

`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` — 38 agents today,
machine-readable, with per-platform distribution info. Relevant entries:

```jsonc
{ "id": "claude-acp", "name": "Claude Agent", "version": "0.67.0",
  "distribution": { "npx": { "package": "@agentclientprotocol/claude-agent-acp@0.67.0" } } }

{ "id": "codex-acp",  "name": "Codex", "version": "1.2.0",
  "distribution": { "npx": { "package": "@agentclientprotocol/codex-acp@1.2.0" } } }

{ "id": "gemini", "distribution": { "npx": { "package": "@google/gemini-cli@0.55.1",
                                             "args": ["--acp"] } } }

{ "id": "cursor", "distribution": { "binary": { "darwin-aarch64": {
    "archive": "https://downloads.cursor.com/...tar.gz",
    "cmd": "./dist-package/cursor-agent", "args": ["acp"] } } } }

{ "id": "opencode", "distribution": { "binary": { "darwin-aarch64": {
    "archive": "https://github.com/anomalyco/opencode/releases/...zip",
    "cmd": "./opencode", "args": ["acp"], "sha256": "7d668bf2…" } } } }
```

Note what this means for us: **neither Claude Code nor Codex speaks ACP natively.** Both go
through Node adapters that wrap their own SDKs —
`@agentclientprotocol/claude-agent-acp` (depends on `@anthropic-ai/claude-agent-sdk`, was
`@zed-industries/claude-code-acp`) and `@agentclientprotocol/codex-acp` (depends on
`@openai/codex`). Cursor, OpenCode, and Gemini ship ACP in their own binary. That
distribution asymmetry is the single biggest practical cost, covered in §5.

### Rust SDK

`agent-client-protocol` **v2.0.0** on crates.io (crate version, not protocol version —
protocol v2 sits behind the `unstable_protocol_v2` feature). This matters a lot for us: the
client side is a first-class supported role, and it's the same crate Zed itself uses.
Companion crates: `-http` (HTTP/SSE + WebSocket), `-rmcp` (MCP integration), `-conductor`
(proxy chains), `-test`.

The client API is genuinely small. From `examples/yolo_one_shot_client.rs` in the SDK:

```rust
let agent = AcpAgent::from_str("npx @agentclientprotocol/claude-agent-acp")?;

agent_client_protocol::Client
    .builder()
    .on_receive_notification(
        async move |notification: SessionNotification, _cx| { /* → Tauri event */ Ok(()) },
        agent_client_protocol::on_receive_notification!(),
    )
    .on_receive_request(
        async move |req: RequestPermissionRequest, responder, _conn| {
            responder.respond(RequestPermissionResponse::new(/* user's choice */))
        },
        agent_client_protocol::on_receive_request!(),
    )
    .connect_with(agent, |conn: ConnectionTo<Agent>| async move {
        conn.send_request(InitializeRequest::new(ProtocolVersion::V1)).block_task().await?;
        let s = conn.send_request(NewSessionRequest::new(cwd)).block_task().await?;
        conn.send_request(PromptRequest::new(s.session_id, blocks)).block_task().await?;
        Ok(())
    })
    .await?;
```

`AcpAgent::from_str` handles the subprocess spawn and stdio framing. Our backend is already
tokio + serde_json, so this drops in.

---

## 2. What Impala does today, and what it actually costs us

Current pipeline: `apps/desktop/src/lib/agent.ts` builds a **shell command string**
(`buildDirectLaunchCommand`) → written into a PTY owned by the `impala-pty-daemon` sidecar →
bytes rendered by `XtermTerminal.tsx`. The agent is a black box; everything structured we
know about it, we learned by instrumenting it from outside:

| File | LOC | What it exists to do |
| --- | --- | --- |
| `backend/tauri/src/hook_server.rs` | 1906 | HTTP server that Claude/Codex hooks POST into; infers turn state by pairing `PreToolUse`/`PostToolUse`, watching `UserPromptSubmit` and `Stop` |
| `backend/tauri/src/agent_config.rs` | 916 | writes `.claude/settings.local.json` hooks per worktree, mutates `~/.codex/config.toml`, computes Codex hook *trust hashes*, registers the MCP sidecar, appends `.git/info/exclude` lines |
| `apps/desktop/src/components/TabbedTerminals.tsx` | 2028 | terminal tabs, status pills, split panes |
| `apps/desktop/src/components/XtermTerminal.tsx` | 789 | xterm rendering, link underlining, buffer restore |

Roughly **2,800 lines of Rust whose only job is to recover, out-of-band, information the
agent already knows and ACP would simply hand us.** The Codex hook-trust hashing in
`agent_config.rs:215-290` is the clearest tell: we are computing SHA-256 hashes of hook
commands to satisfy another tool's trust model, purely to learn when a turn ended.

What we cannot do today at any price, because the data never leaves the terminal:
render tool calls as UI, show a live plan, show per-tool diffs before they hit the worktree,
attach an annotation to the specific tool call that caused a change, drive approvals from a
dialog instead of keystrokes into a TTY, or reliably distinguish "waiting for input" from
"thinking" without hook heuristics.

---

## 3. What T3 Code actually does (and the lesson)

Read `pingdotgg/t3code` at `main`. It is Electron + a Node/Effect-TS server; the interesting
part is `apps/server/src/provider/`.

**Finding that changes the framing: T3 Code does not use ACP for Claude or Codex.** It has
five drivers (`builtInDrivers.ts`), each with its own transport:

| Driver | Transport |
| --- | --- |
| `claudeAgent` | `@anthropic-ai/claude-agent-sdk` directly (`ClaudeAdapter.ts`) |
| `codex` | Codex's own app-server JSON-RPC (`packages/effect-codex-app-server`) |
| `cursor` | **ACP** — spawns `cursor-agent acp` |
| `grok` | **ACP** — plus an `XAiAcpExtension` |
| `opencode` | `@opencode-ai/sdk` |

They reached for ACP exactly where the vendor gave them nothing better, and used the
vendor-native protocol where one existed. Their ACP layer is ~2,900 lines across
`packages/effect-acp/` (protocol, client, agent, generated schema) and
`apps/server/src/provider/acp/` (`AcpSessionRuntime.ts` 1005, `AcpRuntimeModel.ts` 582,
`AcpCoreRuntimeEvents.ts` 242, plus per-vendor extension files).

**The actual architecture lesson is one layer up.** Every driver normalises into a single
canonical event union, `ProviderRuntimeEvent` in `packages/contracts/src/providerRuntime.ts`
(~50 variants):

```
session.started | session.configured | session.state.changed | session.exited
turn.started | turn.completed | turn.aborted | turn.plan.updated | turn.diff.updated
item.started | item.updated | item.completed | content.delta
request.opened | request.resolved | user-input.requested | user-input.resolved
task.* | hook.* | tool.progress | tool.summary | auth.status
account.rate-limits.updated | mcp.status.updated | model.rerouted | runtime.error …
```

The UI subscribes to *that*, never to ACP. `AcpCoreRuntimeEvents.ts` is nothing but the
translation — e.g. ACP tool kind → canonical request type:

```ts
function canonicalRequestTypeFromAcpKind(kind: string | "unknown") {
  switch (kind) {
    case "execute": return "exec_command_approval";
    case "read":    return "file_read_approval";
    case "edit": case "delete": case "move": return "file_change_approval";
    default:        return "dynamic_tool_call";
  }
}
```

Three more things worth stealing:

1. **Session replay is a first-class problem.** `AcpSessionRuntime.ts` has an explicit
   `SessionLoadGate` with `waitForSessionLoadReplayIdle` and a 90s timeout — because
   `session/load` replays the whole history as ordinary `session/update` notifications and
   you must not treat replayed events as live ones. `sessionUpdateIsReplay` exists for this.
2. **Vendor extensions are unavoidable.** `CursorAcpExtension.ts` and `XAiAcpExtension.ts`
   (113 and 432 lines) handle vendor-specific `_ext` methods — Cursor's `create_plan`,
   `update_todos`, `ask_question`. ACP standardises the 80%; the last 20% is still per-vendor.
3. **Buffered vs streaming delivery is a product decision.** `ProviderRuntimeIngestion` can
   accumulate assistant text instead of streaming every delta, spilling at 24,000 chars and
   flushing at interaction boundaries. Relevant to us for mobile/remote later; not for v1.

---

## 4. What ACP buys Impala, and what it costs

### Buys

- **Turn state becomes a fact, not an inference.** `session/prompt` resolves with a
  `stopReason`. `hook_server.rs`'s PreToolUse/PostToolUse pairing machinery has no reason to
  exist for ACP-driven sessions.
- **MCP registration moves into the handshake.** `session/new` takes `mcpServers`. We pass
  the `impala-mcp` sidecar path per session instead of mutating `~/.claude.json` and
  `~/.codex/config.toml` — most of `agent_config.rs` becomes unnecessary for ACP sessions,
  including the Codex trust hashing.
- **Tool calls, diffs, plans, and file locations become renderable.** `locations` on each
  tool call gives us follow-along in the existing `FilesPanel`/`DiffView`. Structured diffs
  arrive *before* the write lands, which opens "review the edit, then approve" — that is
  directly adjacent to what Impala already is.
- **Approvals become UI.** `session/request_permission` gives us a real dialog with the
  agent's own option list, plus per-session modes via `session/set_mode`.
- **`fs/read_text_file` / `fs/write_text_file` route the agent's disk access through us.**
  Impala already tracks viewed files and annotations; being the filesystem for the agent
  means unsaved editor buffers and annotation state can be authoritative.
- **Provider count goes up for near-free.** Gemini, OpenCode, Cursor, Copilot, Goose, Amp,
  and 30+ others are one registry entry each once the client exists.
- **Slash commands survive** — `available_commands_update` advertises them, so our
  `impala-review` / `impala-browser` / `impala-automations` commands still work, and we can
  render them as a real picker instead of typing `/` into a TTY.

### Costs

- **Distribution.** Claude and Codex ACP adapters are **Node packages run via npx**. Impala
  today needs no Node runtime. Options: (a) require Node and shell out to `npx` — simplest,
  but a new hard dependency and a first-run download; (b) vendor the adapters' bundled JS
  plus a pinned Node binary as Tauri sidecars — bloats the DMG by ~50MB per platform;
  (c) implement the registry's `distribution` handling generically (download + verify sha256
  into app data) like Zed does — most work, but it's also how Cursor/OpenCode/Gemini get
  installed and it makes the agent list data-driven. Recommend (c) eventually, (a) for the
  spike.
- **The adapter is a translation layer with its own bugs and lag.** `claude-agent-acp` is at
  0.67.0 and wraps the Agent SDK; new Claude Code features land in the CLI first. We would
  be one hop behind on both vendors, and t3code's git log shows they hit real ACP approval
  bugs.
- **Auth.** `claude-agent-acp` uses the Claude Agent SDK, so it should pick up existing
  `~/.claude` credentials — **needs verification, including subscription vs API-key auth**.
  ACP has `authenticate` + auth method IDs (t3code passes `"cursor_login"`), but a browser
  OAuth flow driven from a GUI is fiddlier than `claude /login` in a terminal.
- **We give up the TUI.** Anything the CLI does that isn't in the protocol — vendor-specific
  interactive prompts, `/resume` pickers, the status line, ctrl-key affordances — is gone in
  ACP mode. This argues strongly for keeping the PTY path rather than replacing it.
- **v1→v2 churn is coming**, and v2 deletes `fs/*` and `terminal/*`. Don't build UI that
  assumes those exist forever.
- **Subagents.** `subagents.rs` (1217 lines) and the delegation tracking in `hook_server.rs`
  have no ACP equivalent — ACP has no first-class subagent concept. Claude's adapter may
  surface them as tool calls; this needs investigating before anything is ported.

---

## 5. Proposed shape for Impala

Mirror t3code's layering, but in Rust, and keep the terminal.

```
apps/desktop
  components/session/           ← new: ThreadView, ToolCallCard, PlanPanel,
                                        PermissionDialog, DiffPreview
  components/XtermTerminal.tsx  ← unchanged, still used for terminal-mode sessions

backend/tauri/src/session/
  mod.rs          SessionKind::{ Pty, Acp } — one registry keyed by worktree + pane
  event.rs        ImpalaSessionEvent — the canonical union (our ProviderRuntimeEvent)
  acp/
    client.rs     agent-client-protocol Client; handlers → mpsc → Tauri emit
    map.rs        SessionUpdate → ImpalaSessionEvent (the only file v2 should touch)
    catalog.rs    ACP registry fetch/cache + spawn command resolution
    fs.rs         fs/read_text_file, fs/write_text_file → Impala's file layer
    terminal.rs   terminal/* → existing pty daemon (already have this!)
  pty/            existing path, re-expressed as SessionKind::Pty
```

Four notes on why this shape:

1. **`ImpalaSessionEvent` is the deliverable, not the ACP client.** If the frontend ever
   imports an ACP type, we've built the wrong thing. Start it small — `turn.started`,
   `turn.completed`, `content.delta`, `tool.started/updated/completed`, `plan.updated`,
   `permission.requested/resolved`, `session.exited` — and grow it. t3code's 50 variants are
   what four years of providers looks like, not a starting point.
2. **`terminal/*` is nearly free for us.** The agent asking the client to run a command maps
   onto the existing `impala-pty-daemon` (`pty_spawn`, `pty_get_buffer` in `pty.rs`). A
   command the agent runs can render in a real terminal pane inside the session view — which
   is a nicer version of what we have now, not a regression.
3. **Persistence.** Sessions must survive app restart. `session/load` replays history, so we
   can rebuild a thread from the agent — but per t3code we need a replay gate so replayed
   events don't re-fire notifications or re-open permission dialogs. Alternative: persist
   `ImpalaSessionEvent`s to the existing SQLite DB (where annotations already live) and treat
   the agent as the source of truth only for live turns. **This is the biggest open design
   question** and probably deserves its own ADR.
4. **Agent choice stays per-worktree** (`selectedAgent`, `resolveAgent` in `lib/agent.ts`).
   Add a `sessionMode: "terminal" | "structured"` alongside it rather than overloading the
   agent key.

### Phasing

| Phase | Scope | Verify by |
| --- | --- | --- |
| 0 | Spike outside the app: Rust bin using `agent-client-protocol` + `npx @agentclientprotocol/claude-agent-acp`, dump `session/update` NDJSON for a real Impala worktree task | We can read a full turn's events, including a tool call with a diff, and know exactly what Claude's adapter does and does not emit |
| 1 | `ImpalaSessionEvent` + `session/acp/client.rs` + `map.rs`; one read-only "ACP thread" pane behind a dev flag, next to the terminal | Prompt → streamed assistant text → tool calls with status → `stopReason`, rendered in-app |
| 2 | Permissions + `session/set_mode` + cancel; `fs/*` handlers wired to Impala's file layer | Approve/deny from a dialog; Esc cancels a turn; agent reads reflect unsaved editor state |
| 3 | `terminal/*` → pty daemon; tool-call diffs into `DiffView`; `locations` → follow-along in `FilesPanel`; annotations anchored to tool calls | An `execute` tool renders live output in-pane; an `edit` tool shows its diff before it lands |
| 4 | Persistence + `session/load` with a replay gate; MCP sidecar via `session/new` instead of config mutation | Restart the app mid-thread and get the thread back; delete the ACP branch's `agent_config.rs` writes |
| 5 | Registry-driven agent catalog; add Gemini/OpenCode/Cursor as data | A new provider is a registry entry, not code |

Nothing in phases 0–3 requires touching the PTY path. That's deliberate — the terminal keeps
working the entire time, and if ACP disappoints us we stop at any phase.

---

## 6. Open questions (need answers before phase 1)

1. **Auth:** does `claude-agent-acp` reuse an existing Claude Code subscription login, or
   does it demand `ANTHROPIC_API_KEY`? Same question for `codex-acp` and ChatGPT auth. If
   either forces API-key billing, that changes the product, not just the plumbing.
2. **Hooks:** does the Claude adapter still honour `.claude/settings.local.json` hooks (via
   the Agent SDK's `settingSources`)? If yes, `hook_server.rs` can stay as-is during the
   transition instead of being forked per session kind.
3. **Subagents:** how does `claude-agent-acp` represent `Task`/subagent runs — nested tool
   calls, or invisible? Determines whether `subagents.rs` survives.
4. **Node dependency:** which distribution option (§4) do we accept? This gates phase 1's
   spawn path and is the one call I'd want made before writing code.
5. **Automations:** `automations.rs` resumes sessions by id (`buildAutomationResumeCommand`).
   Do ACP `sessionId`s survive process restarts for both adapters, i.e. is `session/load`
   usable across app launches, or only within one adapter process lifetime?

## 7. Recommendation

Do phase 0 this week — it's a day of work, needs no Impala changes, and answers questions
1–3 and 5 empirically rather than from docs. Everything after that is a real product bet:
ACP-mode sessions are a genuinely better Impala (structured diffs, real approvals,
annotations anchored to tool calls, a dozen new providers), but they are an *addition* to
the terminal, and the honest cost is a Node runtime dependency plus a permanent translation
layer we don't control.

## Sources

- ACP docs: <https://agentclientprotocol.com> — v1 spec, [v2 migration](https://agentclientprotocol.com/protocol/v2/migration), [registry](https://agentclientprotocol.com/get-started/registry)
- Rust SDK: <https://github.com/agentclientprotocol/rust-sdk> (crate `agent-client-protocol` 2.0.0)
- Adapters: <https://github.com/agentclientprotocol/claude-agent-acp>, <https://github.com/agentclientprotocol/codex-acp>
- T3 Code: <https://github.com/pingdotgg/t3code> — `apps/server/src/provider/`, `packages/effect-acp/`, `packages/contracts/src/providerRuntime.ts`, `docs/internals/providers.md`
- Zed's ACP page and agent list: <https://zed.dev/acp>
