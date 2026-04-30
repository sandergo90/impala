//! OSC 133 shell readiness scanner (FinalTerm semantic prompt standard).
//!
//! Pure scanning logic — no I/O. Callers handle their own readiness
//! resolution (channels, atomics, broadcasts).
//!
//! Protocol ref: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
//! Algorithm vendored from Superset (which vendored from WezTerm, MIT,
//! Copyright 2018-Present Wez Furlong).

/// The OSC 133;A prefix that signals shell prompt start (= shell ready).
const OSC_133_A: &[u8] = b"\x1b]133;A";
/// String terminator (BEL form).
const ST_BEL: u8 = 0x07;

/// Mutable state for the byte-by-byte scanner. Construct one per session
/// via `ShellReadyScanState::new()` and feed every PTY output chunk to
/// `scan` until a match is observed.
#[derive(Debug, Clone)]
pub struct ShellReadyScanState {
    /// Position within `OSC_133_A` we have matched so far. When this
    /// reaches `OSC_133_A.len()`, we are consuming params until ST_BEL.
    match_pos: usize,
    /// Bytes held back from output — flushed on mismatch, discarded on
    /// full match.
    held: Vec<u8>,
}

#[derive(Debug)]
pub struct ScanResult {
    /// Output data with any matched marker stripped. Always ≤ input length.
    pub output: Vec<u8>,
    /// True when a complete marker (prefix + optional params + BEL) was
    /// observed in this chunk.
    pub matched: bool,
}

impl ShellReadyScanState {
    pub fn new() -> Self {
        Self {
            match_pos: 0,
            held: Vec::new(),
        }
    }

    /// Drain any held bytes — used when the caller decides to abandon
    /// scanning (e.g. timeout). After calling this, the state is reset
    /// to a fresh scan.
    pub fn take_held(&mut self) -> Vec<u8> {
        self.match_pos = 0;
        std::mem::take(&mut self.held)
    }

    /// Scan one chunk of PTY output for the OSC 133;A marker.
    pub fn scan(&mut self, data: &[u8]) -> ScanResult {
        let mut output = Vec::with_capacity(data.len());

        for (i, &byte) in data.iter().enumerate() {
            if self.match_pos < OSC_133_A.len() {
                if byte == OSC_133_A[self.match_pos] {
                    self.held.push(byte);
                    self.match_pos += 1;
                } else {
                    // Mismatch — flush held bytes as output, re-test current
                    // byte as a possible fresh match start (handles cases
                    // like \x1b\x1b]133;A\x07 where the first ESC is real
                    // output and the second begins the marker).
                    output.extend_from_slice(&self.held);
                    self.held.clear();
                    self.match_pos = 0;
                    if byte == OSC_133_A[0] {
                        self.held.push(byte);
                        self.match_pos = 1;
                    } else {
                        output.push(byte);
                    }
                }
            } else {
                // Prefix matched — consume params until BEL.
                if byte == ST_BEL {
                    // Full match — discard held bytes and append any bytes
                    // that came after the marker in this same chunk.
                    self.held.clear();
                    self.match_pos = 0;
                    output.extend_from_slice(&data[i + 1..]);
                    return ScanResult { output, matched: true };
                }
                self.held.push(byte);
            }
        }

        ScanResult { output, matched: false }
    }
}

impl Default for ShellReadyScanState {
    fn default() -> Self {
        Self::new()
    }
}

/// Shells whose wrapper rc files inject OSC 133 markers via a `precmd` hook.
/// Other shells (`sh`, `ksh`, `pwsh`, `cmd.exe`) get marked "unsupported"
/// and their write gating is bypassed.
pub fn shell_supports_marker(shell_basename: &str) -> bool {
    matches!(shell_basename, "zsh" | "bash" | "fish")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_one(input: &[u8]) -> (Vec<u8>, bool) {
        let mut s = ShellReadyScanState::new();
        let r = s.scan(input);
        (r.output, r.matched)
    }

    #[test]
    fn passes_through_plain_text() {
        let (out, matched) = scan_one(b"hello world\n");
        assert_eq!(out, b"hello world\n");
        assert!(!matched);
    }

    #[test]
    fn matches_bare_marker() {
        let (out, matched) = scan_one(b"\x1b]133;A\x07");
        assert!(out.is_empty());
        assert!(matched);
    }

    #[test]
    fn matches_marker_with_params() {
        let (out, matched) = scan_one(b"\x1b]133;A;cl=m;aid=99\x07");
        assert!(out.is_empty());
        assert!(matched);
    }

    #[test]
    fn strips_marker_from_surrounding_output() {
        let (out, matched) = scan_one(b"prompt> \x1b]133;A\x07$ ");
        assert_eq!(out, b"prompt> $ ");
        assert!(matched);
    }

    #[test]
    fn marker_split_across_chunks() {
        let mut s = ShellReadyScanState::new();
        let r1 = s.scan(b"\x1b]13");
        assert!(r1.output.is_empty());
        assert!(!r1.matched);
        let r2 = s.scan(b"3;A\x07rest");
        assert_eq!(r2.output, b"rest");
        assert!(r2.matched);
    }

    #[test]
    fn mismatch_flushes_held_bytes() {
        let (out, matched) = scan_one(b"\x1b]133;Bxxx");
        assert_eq!(out, b"\x1b]133;Bxxx");
        assert!(!matched);
    }

    #[test]
    fn double_esc_recovers_to_real_marker() {
        // First \x1b is regular output, second begins the marker.
        let (out, matched) = scan_one(b"\x1b\x1b]133;A\x07");
        assert_eq!(out, b"\x1b");
        assert!(matched);
    }

    #[test]
    fn take_held_returns_partial_match_bytes() {
        let mut s = ShellReadyScanState::new();
        let r = s.scan(b"\x1b]133");
        assert!(r.output.is_empty());
        assert!(!r.matched);
        let drained = s.take_held();
        assert_eq!(drained, b"\x1b]133");
        // State is reset — subsequent plain input passes through.
        let r2 = s.scan(b"ok");
        assert_eq!(r2.output, b"ok");
    }

    #[test]
    fn shell_supports_marker_truth_table() {
        assert!(shell_supports_marker("zsh"));
        assert!(shell_supports_marker("bash"));
        assert!(shell_supports_marker("fish"));
        assert!(!shell_supports_marker("sh"));
        assert!(!shell_supports_marker("ksh"));
        assert!(!shell_supports_marker("pwsh"));
    }
}
