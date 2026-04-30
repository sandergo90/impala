use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Hello {
        token: String,
        client_version: String,
        protocol_version: u32,
    },
    List,
    Spawn {
        session_id: String,
        cwd: String,
        command: Option<Vec<String>>,
        /// Override the user's `$SHELL` (e.g. force `/bin/zsh` even if their
        /// SHELL env var is `/usr/local/bin/fish`). When `None`, the daemon
        /// uses `$SHELL` and falls back to `/bin/zsh`.
        shell_path: Option<String>,
        /// Override the default `["-l"]` shell launch args. Used to inject
        /// `--rcfile` (bash) or `--init-command` (fish).
        shell_args: Option<Vec<String>>,
        env: Vec<(String, String)>,
        cols: u16,
        rows: u16,
    },
    Write {
        session_id: String,
        data_b64: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        session_id: String,
    },
    IsAlive {
        session_id: String,
    },
    GetBuffer {
        session_id: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    HelloOk {
        daemon_version: String,
        protocol_version: u32,
        pid: u32,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    /// `already_existed` is true when reconnecting to a session that
    /// survived an app restart. `scrollback_b64` is the current screen
    /// state for immediate replay into xterm. `seq_upto` is the total
    /// byte count of PTY output covered by the snapshot — the client
    /// uses it as a watermark to drop any Output events whose bytes are
    /// already included in the scrollback.
    Spawned {
        session_id: String,
        already_existed: bool,
        scrollback_b64: String,
        seq_upto: u64,
    },
    Wrote,
    Resized,
    Killed,
    Alive {
        alive: bool,
    },
    Buffer {
        session_id: String,
        data_b64: String,
        seq_upto: u64,
    },
    ShutdownAck,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Output {
        session_id: String,
        data_b64: String,
        /// Byte offset of the first byte in this chunk within the
        /// session's monotonic output stream. Paired with `seq_upto`
        /// on a Spawned/Buffer response, lets a reattaching client
        /// discard chunks whose bytes are already in the snapshot.
        seq_from: u64,
    },
    Exit {
        session_id: String,
        code: i32,
    },
    SpawnError {
        session_id: String,
        message: String,
    },
    ShellReady {
        session_id: String,
        /// "ready" — OSC 133;A marker observed.
        /// "timed_out" — 15s elapsed without marker (broken wrapper or exotic shell).
        /// "unsupported" — shell has no marker support (sh/ksh/pwsh); fired immediately.
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientFrame {
    pub id: u64,
    #[serde(flatten)]
    pub req: Request,
}

// Server frames are dispatched manually by inspecting the `kind` field on
// the wire. Wrapping Response/Event in an internally-tagged enum with
// `flatten` tickles a known serde deserialization hole, so we keep these
// as plain structs and let the reader peek at `kind` before parsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseFrame {
    pub kind: String, // always "response"
    pub id: u64,
    #[serde(flatten)]
    pub resp: Response,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventFrame {
    pub kind: String, // always "event"
    #[serde(flatten)]
    pub event: Event,
}

pub const KIND_RESPONSE: &str = "response";
pub const KIND_EVENT: &str = "event";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_frame_roundtrip() {
        let frame = ResponseFrame {
            kind: KIND_RESPONSE.into(),
            id: 7,
            resp: Response::HelloOk {
                daemon_version: "1.2.3".into(),
                protocol_version: 3,
                pid: 4242,
            },
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains(r#""kind":"response""#));
        assert!(json.contains(r#""type":"hello_ok""#));
        let back: ResponseFrame = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, 7);
        assert!(matches!(back.resp, Response::HelloOk { pid: 4242, .. }));
    }

    #[test]
    fn spawned_roundtrip_carries_seq() {
        let frame = ResponseFrame {
            kind: KIND_RESPONSE.into(),
            id: 3,
            resp: Response::Spawned {
                session_id: "sess".into(),
                already_existed: true,
                scrollback_b64: "AAA=".into(),
                seq_upto: 12345,
            },
        };
        let json = serde_json::to_string(&frame).unwrap();
        let back: ResponseFrame = serde_json::from_str(&json).unwrap();
        match back.resp {
            Response::Spawned {
                session_id,
                seq_upto,
                ..
            } => {
                assert_eq!(session_id, "sess");
                assert_eq!(seq_upto, 12345);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn event_frame_roundtrip() {
        let frame = EventFrame {
            kind: KIND_EVENT.into(),
            event: Event::Output {
                session_id: "s1".into(),
                data_b64: "aGVsbG8=".into(),
                seq_from: 9000,
            },
        };
        let json = serde_json::to_string(&frame).unwrap();
        let back: EventFrame = serde_json::from_str(&json).unwrap();
        match back.event {
            Event::Output { seq_from, .. } => assert_eq!(seq_from, 9000),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn shell_ready_event_roundtrip() {
        let frame = EventFrame {
            kind: KIND_EVENT.into(),
            event: Event::ShellReady {
                session_id: "s1".into(),
                reason: "ready".into(),
            },
        };
        let json = serde_json::to_string(&frame).unwrap();
        let back: EventFrame = serde_json::from_str(&json).unwrap();
        match back.event {
            Event::ShellReady { session_id, reason } => {
                assert_eq!(session_id, "s1");
                assert_eq!(reason, "ready");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn client_frame_roundtrip() {
        let frame = ClientFrame {
            id: 1,
            req: Request::Spawn {
                session_id: "s".into(),
                cwd: "/tmp".into(),
                command: Some(vec!["ls".into()]),
                shell_path: None,
                shell_args: None,
                env: vec![],
                cols: 80,
                rows: 24,
            },
        };
        let json = serde_json::to_string(&frame).unwrap();
        let back: ClientFrame = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, 1);
        assert!(matches!(back.req, Request::Spawn { .. }));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub started_at: String,
    pub alive: bool,
}
