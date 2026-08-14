# Server and thread identity

Sander established that a normally rendering TUI proves only the TUI's connection. Impala must independently initialize against the same app-server daemon and address the same `threadId`; matching only the pane or thread ID is insufficient when clients may resolve different `CODEX_HOME` values and control sockets.

## Evidence

He identified that Impala also needs to be attached to the thread, then confirmed the sharper formulation: reliable attachment requires matching both server identity and thread identity.
