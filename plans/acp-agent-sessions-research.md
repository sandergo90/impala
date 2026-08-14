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

## 4. The Claude adapter, read from source

Read `agentclientprotocol/claude-agent-acp` at `main` (`src/acp-agent.ts`). It answers most
of what §7 originally listed as open, and it answers it better than expected.

### Auth: the subscription works, and Impala is unusually well placed to drive it

`initialize` advertises (`src/acp-agent.ts:1690-1725`):

```ts
const claudeLoginMethod: AuthMethod = {
  id: "claude-ai-login",
  name: "Claude Subscription",
  description: "Use Claude subscription ",
  type: "terminal",
  args: ["--cli", "auth", "login", "--claudeai"],
};
// plus:
//   console-login          → Anthropic Console (API usage billing)
//   gateway / gateway-bedrock → custom Anthropic/Bedrock gateway
//   agentCapabilities.auth = { logout: {} }
```

Three details that matter:

- **These are gated on the client.** They only appear if we advertise
  `clientCapabilities.auth.terminal === true` (or `_meta["terminal-auth"] === true`). A
  client that doesn't ask, doesn't get subscription login.
- **`type: "terminal"` means the *client* runs the login, not the `authenticate` RPC.**
  `authenticate()` only implements the gateway methods and throws
  `"Method not implemented."` for everything else. With the `terminal-auth` capability the
  adapter hands us the exact spawn spec — `_meta["terminal-auth"] = { command:
  process.execPath, args: [...process.argv.slice(1), "--cli", "auth", "login",
  "--claudeai"], label: "Claude Login" }`.
- **This is the awkward part for most ACP clients and the easy part for us.** Editors
  without a terminal have to shell out or embed one. Impala already owns
  `impala-pty-daemon` and `XtermTerminal.tsx` — the login flow is "spawn that command in a
  terminal pane we already have." Keeping the PTY path isn't just a fallback; it's what
  makes the ACP path's auth pleasant.

The adapter also detects remote environments (`SSH_CONNECTION`, `NO_BROWSER`,
`CLAUDE_CODE_REMOTE`, …) where the OAuth localhost redirect fails, and swaps in a
`claude-login` method that runs `claude /login` in a TUI instead. Relevant if Impala ever
grows remote worktrees.

### Capabilities it advertises

```jsonc
{
  "loadSession": true,
  "sessionCapabilities": { "additionalDirectories": {}, "close": {}, "delete": {},
                           "fork": {}, "list": {}, "resume": {} },
  "promptCapabilities": { "image": true, "embeddedContext": true },
  "mcpCapabilities": { "http": true, "sse": true },
  "auth": { "logout": {} },
  "providers": {},                                  // providers/list|set|disable
  "_meta": { "steering": { "supported": true },     // inject into a *running* turn
             "claudeCode": { "promptQueueing": true } }
}
```

`fork`, `list`, `resume`, `steering` and `providers` are all things the terminal path
can't give us at all.

### The originally-open questions, now answered

- **Session persistence (was Q5).** `listSessions` delegates to the Agent SDK's
  `listSessions({ dir })`, which reads Claude's on-disk session store and returns
  `sessionId`, `cwd`, `title`, `updatedAt`. So session ids survive process and app
  restarts and are enumerable per worktree. `automations.rs`'s resume-by-id model carries
  over, and we get a "resume a previous thread here" picker essentially free.
- **Hooks and MCP (was Q2).** `session/new` accepts `_meta.claudeCode.options`, where
  `hooks`, `mcpServers` and `disallowedTools` are explicitly **merged** with ACP's rather
  than replaced. Our `.claude/settings.local.json` hooks keep firing, so `hook_server.rs`
  can stay untouched during a transition instead of being forked per session kind.
  `cwd`, `permissionMode`, `canUseTool` and `executable` are taken over by ACP.
- **Subagents (was Q3).** Not invisible: `parentToolUseId` attributes a subagent's tool
  calls to the `Task` call that spawned them, carried in `_meta` on both the streamed and
  permission paths. `TodoWrite` renders as a `plan` update and `Task*` is suppressed from
  the stream but still resolved at tool-result time. So `subagents.rs`'s delegation model
  has a real mapping — nested tool calls with parent attribution — rather than needing to
  be rebuilt.
- **Permission modes.** `default | acceptEdits | plan | bypassPermissions`, driven through
  `session/set_mode`, with `bypassPermissions` refused when running as root. Permission
  requests carry a `{ kind: "reject_once", name: "No, keep planning", optionId: "plan" }`
  option — i.e. plan mode is a first-class approval outcome, not a flag.

### The escape hatch

`_meta.claudeCode.emitRawSDKMessages` (bool or a `SDKMessageFilter[]`) makes the adapter
emit raw Agent SDK messages as `extNotification("_claude/sdkMessage", message)` alongside
normal processing. This is the answer to "what if ACP's vocabulary is too narrow" — for
Claude specifically we are **not** capped by the protocol, we can subscribe to the raw
stream for anything Impala-specific and still render the standard 95% from typed events.

---

## 5. What ACP buys Impala, and what it costs

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
- **We give up the TUI.** Anything the CLI does that isn't in the protocol — vendor-specific
  interactive prompts, the status line, ctrl-key affordances — is gone in ACP mode. Less
  severe than it first looked (`/resume` is covered by `session/list`, slash commands by
  `available_commands_update`), but it still argues for keeping the PTY path rather than
  replacing it — not least because terminal-type auth needs it (§4).
- **Codex's auth story is unverified.** §4 covers Claude only. `codex-acp` depends on
  `@openai/codex` and needs the same read before we assume ChatGPT-subscription auth works.
- **v1→v2 churn is coming**, and v2 deletes `fs/*` and `terminal/*`. Don't build UI that
  assumes those exist forever.
- **Subagents.** `subagents.rs` (1217 lines) and the delegation tracking in `hook_server.rs`
  have no ACP equivalent — ACP has no first-class subagent concept. Claude's adapter may
  surface them as tool calls; this needs investigating before anything is ported.

---

## 6. Proposed shape for Impala

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
3. **Persistence.** Claude's adapter stores sessions on disk and exposes them via
   `session/list` (§4), so the agent can be the source of truth: `session/load` replays
   history, `session/resume` reconnects without replaying. Per t3code we still need a replay
   gate so replayed events don't re-fire notifications or re-open permission dialogs.
   Whether we *also* mirror `ImpalaSessionEvent`s into the existing SQLite DB (where
   annotations already live) is now an optimisation — needed if we want thread search or
   offline history, not needed for correctness. Still worth its own ADR, but no longer the
   blocking unknown.
4. **Agent choice stays per-worktree** (`selectedAgent`, `resolveAgent` in `lib/agent.ts`).
   Add a `sessionMode: "terminal" | "structured"` alongside it rather than overloading the
   agent key. The two modes are not exclusive per worktree — terminal-type auth (§4) means
   an ACP session may need to *borrow* a terminal pane mid-flow.

### Phasing

| Phase | Scope | Verify by |
| --- | --- | --- |
| 0 | Spike outside the app: Rust bin using `agent-client-protocol` + `npx @agentclientprotocol/claude-agent-acp`, advertising `clientCapabilities.auth.terminal`, dumping `session/update` NDJSON for a real Impala worktree task | A full turn's events captured — tool call with a diff, subagent `parentToolUseId` attribution, `stopReason` — and confirmation that an already-logged-in machine never needs `authenticate` |
| 1 | `ImpalaSessionEvent` + `session/acp/client.rs` + `map.rs`; one read-only "ACP thread" pane behind a dev flag, next to the terminal | Prompt → streamed assistant text → tool calls with status → `stopReason`, rendered in-app |
| 2 | Permissions + `session/set_mode` + cancel; `fs/*` handlers wired to Impala's file layer; terminal-type auth spawned into a pty pane | Approve/deny from a dialog; Esc cancels a turn; a logged-out machine can complete `claude-ai-login` without leaving Impala |
| 3 | `terminal/*` → pty daemon; tool-call diffs into `DiffView`; `locations` → follow-along in `FilesPanel`; annotations anchored to tool calls | An `execute` tool renders live output in-pane; an `edit` tool shows its diff before it lands |
| 4 | `session/list` + `session/load` with a replay gate; MCP sidecar and hooks via `session/new` `_meta.claudeCode.options` instead of config mutation | Restart the app mid-thread and get the thread back; pick a prior thread for a worktree from a list; delete the ACP branch's `agent_config.rs` writes |
| 5 | Registry-driven agent catalog; add Gemini/OpenCode/Cursor as data | A new provider is a registry entry, not code |
| 6 | Opportunistic, once the above lands: `session/fork`, `steering` (inject into a running turn), `providers/*` model routing | Each is a small UI on top of an existing capability, none has a terminal equivalent |

Nothing in phases 0–3 requires touching the PTY path. That's deliberate — the terminal keeps
working the entire time, and if ACP disappoints us we stop at any phase.

---

## 7. Open questions

Auth, hooks, subagents and session persistence were the original four; §4 closes all of
them for Claude. What's left:

1. **Node dependency — the one real decision.** Which of the three distribution options in
   §5 do we accept? This gates phase 1's spawn path and is the only question I'd want
   settled before code is written.
2. **Codex.** Everything in §4 is Claude-specific. `codex-acp` needs the same source read:
   ChatGPT-subscription auth, whether Codex sessions are listable/resumable, and what its
   `_meta` surface looks like. Assume nothing carries over.
3. **Automations.** `automations.rs` resumes by id and expects a *non-interactive* run to
   completion. ACP's `session/prompt` fits that well, but the scheduled path also needs to
   decide what happens when a turn stops on `session/request_permission` with no user
   present — auto-deny, `bypassPermissions` mode, or fail the run.
4. **Where annotations attach.** Tool calls give us a much finer anchor than "this
   worktree" — but `toolCallId` is session-scoped and its stability across `session/load`
   replay is unverified. Affects the schema, so worth checking during phase 0.

## 8. Recommendation

Stronger than when I started. The subscription-auth finding removes the one risk that could
have made this a non-starter, and reading the adapter turned up several things with **no
terminal equivalent at all**: `session/fork`, `session/list`, steering a running turn,
`providers/*` model routing, and subagent tool calls with parent attribution.

Do phase 0 anyway — a day, no Impala changes — but its purpose has shifted from "is this
viable" to "capture the real event shapes before designing `ImpalaSessionEvent`." Get the
Node-distribution call made in parallel, since that's now the gate.

The honest remaining cost is unchanged and worth restating: a Node runtime dependency, a
translation layer we don't control that lags the CLIs, and a v1→v2 protocol migration on
the horizon. But ACP-mode sessions are an *addition* to the terminal, not a replacement —
and terminal-type auth means the PTY earns its keep even in the ACP world.

## Sources

- ACP docs: <https://agentclientprotocol.com> — v1 spec, [v2 migration](https://agentclientprotocol.com/protocol/v2/migration), [registry](https://agentclientprotocol.com/get-started/registry)
- Rust SDK: <https://github.com/agentclientprotocol/rust-sdk> (crate `agent-client-protocol` 2.0.0)
- Adapters: <https://github.com/agentclientprotocol/claude-agent-acp> (§4 is read from
  `src/acp-agent.ts` at `main` — auth methods ~1629-1790, capabilities ~1745-1795,
  `listSessions`/`loadSession`/`resumeSession` ~1828-1870, `NewSessionMeta` ~788-815,
  subagent attribution ~5310-5330), <https://github.com/agentclientprotocol/codex-acp>
- T3 Code: <https://github.com/pingdotgg/t3code> — `apps/server/src/provider/`, `packages/effect-acp/`, `packages/contracts/src/providerRuntime.ts`, `docs/internals/providers.md`
- Zed's ACP page and agent list: <https://zed.dev/acp>
