# Thread identity and conversation ownership

Sander established that Impala must address the Codex app server with the originating `threadId` to wake the correct conversation. A pane ID identifies the terminal presentation, while the app server owns conversation state and turn creation; this distinction unlocks lessons about connection lifecycle and reliable completion delivery.

## Evidence

He correctly identified the Codex thread ID as the information Impala needs beyond the pane ID after explaining why app-server delivery is required.
