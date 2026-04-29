use std::path::{Path, PathBuf};

pub struct DaemonPaths {
    pub root: PathBuf,
    pub sock: PathBuf,
    pub token: PathBuf,
    pub pid: PathBuf,
    pub version: PathBuf,
    pub log: PathBuf,
    pub history: PathBuf,
}

// Dev and bundled builds share the app data dir, so namespace per-profile to
// stop a leaked `bun run dev` daemon from squatting on the bundled app's
// socket (and vice versa).
#[cfg(debug_assertions)]
const SUFFIX: &str = "-dev";
#[cfg(not(debug_assertions))]
const SUFFIX: &str = "";

impl DaemonPaths {
    pub fn under(app_data_dir: &Path) -> Self {
        let root = app_data_dir.join("daemon");
        Self {
            sock: root.join(format!("pty{SUFFIX}.sock")),
            token: root.join(format!("pty{SUFFIX}.token")),
            pid: root.join(format!("pty{SUFFIX}.pid")),
            version: root.join(format!("version{SUFFIX}")),
            log: root.join(format!("daemon{SUFFIX}.log")),
            history: root.join(format!("history{SUFFIX}")),
            root,
        }
    }
}
