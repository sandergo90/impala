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

impl DaemonPaths {
    pub fn under(app_data_dir: &Path) -> Self {
        let root = app_data_dir.join("daemon");
        Self {
            sock: root.join("pty.sock"),
            token: root.join("pty.token"),
            pid: root.join("pty.pid"),
            version: root.join("version"),
            log: root.join("daemon.log"),
            history: root.join("history"),
            root,
        }
    }
}
