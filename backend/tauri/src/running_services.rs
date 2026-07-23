use crate::daemon_client::DaemonState;
use crate::DbState;
use impala_daemon_shared::wire::{Request, Response, SessionInfo};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningService {
    pub port: u16,
    pub address: String,
    pub pid: u32,
    pub process_name: String,
    pub worktree_path: String,
    pub session_id: Option<String>,
    pub managed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Listener {
    pid: u32,
    process_name: String,
    address: String,
    port: u16,
}

async fn daemon_sessions(state: &DaemonState) -> Result<Vec<SessionInfo>, String> {
    match state.client().await?.request(Request::List).await? {
        Response::Sessions { sessions } => Ok(sessions),
        Response::Error { message } => Err(message),
        _ => Err("unexpected daemon response".into()),
    }
}

#[tauri::command]
pub async fn list_running_services(
    state: tauri::State<'_, DaemonState>,
    db: tauri::State<'_, DbState>,
    project_path: String,
) -> Result<Vec<RunningService>, String> {
    authorize_project(&db, &project_path)?;
    let sessions = daemon_sessions(&state).await.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let worktree_paths = project_worktree_paths(&project_path)?;
        scan_running_services(&worktree_paths, &sessions)
    })
    .await
    .map_err(|error| format!("service scan task failed: {error}"))?
}

#[tauri::command]
pub async fn terminate_running_service(
    state: tauri::State<'_, DaemonState>,
    db: tauri::State<'_, DbState>,
    pid: u32,
    port: u16,
    project_path: String,
) -> Result<(), String> {
    authorize_project(&db, &project_path)?;
    // Stopping must fail closed: without the daemon inventory we cannot prove
    // that the listener is not an Impala terminal's root shell.
    let sessions = daemon_sessions(&state).await?;
    tokio::task::spawn_blocking(move || {
        let worktree_paths = project_worktree_paths(&project_path)?;
        let services = scan_running_services(&worktree_paths, &sessions)?;
        let service = services
            .iter()
            .find(|service| service.pid == pid && service.port == port)
            .ok_or_else(|| "The process no longer owns this project port.".to_string())?;
        if sessions
            .iter()
            .any(|session| session.pid == Some(service.pid))
        {
            return Err("Refusing to stop an Impala terminal shell.".into());
        }
        #[cfg(unix)]
        {
            let result = unsafe { libc::kill(service.pid as i32, libc::SIGTERM) };
            if result != 0 {
                return Err(format!(
                    "Could not stop process {}: {}",
                    service.pid,
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let _ = service;
            Err("Stopping services is currently supported on Unix only.".into())
        }
    })
    .await
    .map_err(|error| format!("service stop task failed: {error}"))?
}

fn authorize_project(db: &DbState, project_path: &str) -> Result<(), String> {
    let conn =
        db.0.lock()
            .map_err(|error| format!("DB lock error: {error}"))?;
    let projects = crate::settings::load_projects(&conn)?;
    projects
        .iter()
        .any(|registered| {
            canonical_path(Path::new(registered)) == canonical_path(Path::new(project_path))
        })
        .then_some(())
        .ok_or_else(|| "Project is not registered in Impala.".to_string())
}

fn project_worktree_paths(project_path: &str) -> Result<Vec<String>, String> {
    Ok(crate::git::list_worktrees(project_path)?
        .into_iter()
        .map(|worktree| worktree.path)
        .collect())
}

fn scan_running_services(
    worktree_paths: &[String],
    sessions: &[SessionInfo],
) -> Result<Vec<RunningService>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (worktree_paths, sessions);
        return Ok(Vec::new());
    }

    #[cfg(target_os = "macos")]
    {
        let worktree_paths = validated_worktree_paths(worktree_paths);
        if worktree_paths.is_empty() {
            return Ok(Vec::new());
        }
        let listener_output = run_command("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])?;
        let listeners = parse_listeners(&listener_output);
        if listeners.is_empty() {
            return Ok(Vec::new());
        }

        let pid_list = listeners
            .iter()
            .map(|listener| listener.pid.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let cwd_output =
            run_command("lsof", &["-a", "-p", &pid_list, "-d", "cwd", "-Fpn"]).unwrap_or_default();
        let cwd_by_pid = parse_cwds(&cwd_output);
        let ps_output = run_command("ps", &["-axo", "pid=,ppid="]).unwrap_or_default();
        let parents = parse_parents(&ps_output);
        Ok(associate_services(
            listeners,
            cwd_by_pid,
            parents,
            &worktree_paths,
            sessions,
        ))
    }
}

fn run_command(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run {program}: {error}"))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(format!("{program} exited with {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_listeners(output: &str) -> Vec<Listener> {
    let mut listeners = Vec::new();
    let mut pid = None;
    let mut process_name = String::new();
    for line in output.lines() {
        let Some((field, value)) = line.split_at_checked(1) else {
            continue;
        };
        match field {
            "p" => {
                pid = value.parse().ok();
                process_name.clear();
            }
            "c" => process_name = value.to_string(),
            "n" => {
                let Some(current_pid) = pid else { continue };
                let endpoint = value.split("->").next().unwrap_or(value);
                let Some((address, port)) = endpoint.rsplit_once(':') else {
                    continue;
                };
                let Ok(port) = port.parse() else { continue };
                listeners.push(Listener {
                    pid: current_pid,
                    process_name: process_name.clone(),
                    address: address.trim_matches(['[', ']']).to_string(),
                    port,
                });
            }
            _ => {}
        }
    }
    listeners
}

fn parse_cwds(output: &str) -> HashMap<u32, PathBuf> {
    let mut result = HashMap::new();
    let mut pid = None;
    for line in output.lines() {
        let Some((field, value)) = line.split_at_checked(1) else {
            continue;
        };
        match field {
            "p" => pid = value.parse().ok(),
            "n" => {
                if let Some(current_pid) = pid {
                    result.insert(current_pid, PathBuf::from(value));
                }
            }
            _ => {}
        }
    }
    result
}

fn parse_parents(output: &str) -> HashMap<u32, u32> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .collect()
}

fn canonical_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn validated_worktree_paths(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| {
            let root = std::fs::canonicalize(path).ok()?;
            root.join(".git").exists().then(|| path.clone())
        })
        .collect()
}

fn matching_worktree<'a>(path: &Path, worktrees: &'a [(String, PathBuf)]) -> Option<&'a str> {
    worktrees
        .iter()
        .filter(|(_, root)| path.starts_with(root))
        .max_by_key(|(_, root)| root.components().count())
        .map(|(original, _)| original.as_str())
}

fn owning_session<'a>(
    pid: u32,
    parents: &HashMap<u32, u32>,
    roots: &'a HashMap<u32, &'a SessionInfo>,
) -> Option<&'a SessionInfo> {
    let mut current = pid;
    let mut seen = HashSet::new();
    while seen.insert(current) {
        if let Some(session) = roots.get(&current) {
            return Some(session);
        }
        current = *parents.get(&current)?;
    }
    None
}

fn associate_services(
    listeners: Vec<Listener>,
    cwd_by_pid: HashMap<u32, PathBuf>,
    parents: HashMap<u32, u32>,
    worktree_paths: &[String],
    sessions: &[SessionInfo],
) -> Vec<RunningService> {
    let worktrees = worktree_paths
        .iter()
        .map(|path| (path.clone(), canonical_path(Path::new(path))))
        .collect::<Vec<_>>();
    let roots = sessions
        .iter()
        .filter(|session| session.alive)
        .filter_map(|session| Some((session.pid?, session)))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut services = Vec::new();

    for listener in listeners {
        if !seen.insert((listener.pid, listener.port)) {
            continue;
        }
        let session = owning_session(listener.pid, &parents, &roots);
        let direct_worktree = cwd_by_pid
            .get(&listener.pid)
            .and_then(|cwd| matching_worktree(&canonical_path(cwd), &worktrees));
        let session_worktree = session.and_then(|owner| {
            matching_worktree(&canonical_path(Path::new(&owner.cwd)), &worktrees)
        });
        let Some(worktree_path) = direct_worktree.or(session_worktree) else {
            continue;
        };
        services.push(RunningService {
            port: listener.port,
            address: listener.address,
            pid: listener.pid,
            process_name: listener.process_name,
            worktree_path: worktree_path.to_string(),
            session_id: session.map(|owner| owner.session_id.clone()),
            managed: session.is_some(),
        });
    }
    services.sort_by_key(|service| (service.worktree_path.clone(), service.port, service.pid));
    services
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, cwd: &str, pid: u32) -> SessionInfo {
        SessionInfo {
            session_id: id.into(),
            cwd: cwd.into(),
            started_at: "now".into(),
            alive: true,
            pid: Some(pid),
        }
    }

    #[test]
    fn parses_lsof_listener_records() {
        let parsed =
            parse_listeners("p42\ncnode\nn*:3000\nn[::1]:3000\np51\ncpython\nn127.0.0.1:8000\n");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].port, 3000);
        assert_eq!(parsed[2].process_name, "python");
    }

    #[test]
    fn accepts_only_existing_git_worktree_roots_for_process_scoping() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let paths = vec!["/".to_string(), root.path().to_string_lossy().into_owned()];
        assert_eq!(
            validated_worktree_paths(&paths),
            vec![root.path().to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn associates_direct_and_descendant_processes_and_deduplicates_ports() {
        let listeners = vec![
            Listener {
                pid: 42,
                process_name: "node".into(),
                address: "*".into(),
                port: 3000,
            },
            Listener {
                pid: 42,
                process_name: "node".into(),
                address: "::1".into(),
                port: 3000,
            },
            Listener {
                pid: 77,
                process_name: "vite".into(),
                address: "127.0.0.1".into(),
                port: 5173,
            },
        ];
        let cwds = HashMap::from([(42, PathBuf::from("/code/app/web"))]);
        let parents = HashMap::from([(77, 10)]);
        let sessions = vec![session("pty-app", "/code/app", 10)];
        let services = associate_services(
            listeners,
            cwds,
            parents,
            &["/code".into(), "/code/app".into()],
            &sessions,
        );
        assert_eq!(services.len(), 2);
        assert!(services
            .iter()
            .all(|service| service.worktree_path == "/code/app"));
        assert_eq!(
            services
                .iter()
                .find(|service| service.pid == 77)
                .unwrap()
                .session_id
                .as_deref(),
            Some("pty-app")
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonicalizes_listener_cwds_before_matching_symlinked_paths() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let real_root = parent.path().join("real");
        let linked_root = parent.path().join("linked");
        std::fs::create_dir_all(real_root.join("web")).unwrap();
        symlink(&real_root, &linked_root).unwrap();
        let listeners = vec![Listener {
            pid: 42,
            process_name: "node".into(),
            address: "*".into(),
            port: 3000,
        }];
        let services = associate_services(
            listeners,
            HashMap::from([(42, linked_root.join("web"))]),
            HashMap::new(),
            &[real_root.to_string_lossy().into_owned()],
            &[],
        );
        assert_eq!(services.len(), 1);
    }
}
