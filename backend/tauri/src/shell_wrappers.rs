//! Generates wrapper rc files that source the user's real rc files and
//! emit the OSC 133;A prompt-start marker so the PTY daemon can detect
//! shell readiness.
//!
//! Reference: ../../../superset/apps/desktop/src/main/lib/agent-setup/shell-wrappers.ts

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use anyhow::{Context, Result};

const ZSH_133_HOOK: &str = r#"# Impala OSC 133;A prompt marker — fires after every precmd
__impala_prompt_mark() {
  printf "\033]133;A\007"
}
typeset -ga precmd_functions 2>/dev/null || true
precmd_functions=(${precmd_functions[@]} __impala_prompt_mark)
"#;

const BASH_133_HOOK: &str = r#"# Impala OSC 133;A prompt marker — chained into PROMPT_COMMAND
__impala_prompt_mark() {
  printf "\033]133;A\007"
}
case ";${PROMPT_COMMAND-};" in
  *";__impala_prompt_mark;"*) ;;
  *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}__impala_prompt_mark" ;;
esac
"#;

const FISH_133_HOOK: &str = r#"# Impala OSC 133;A prompt marker
function __impala_prompt_mark --on-event fish_prompt
    printf '\033]133;A\007'
end
"#;

const CODEX_WRAPPER: &str = r#"#!/bin/sh
real_codex="${IMPALA_CODEX_BIN:-}"
if [ ! -x "$real_codex" ]; then
  shim_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  clean_path=""
  old_ifs=$IFS
  IFS=:
  for entry in $PATH; do
    [ "$entry" = "$shim_dir" ] && continue
    clean_path="${clean_path:+$clean_path:}$entry"
  done
  IFS=$old_ifs
  PATH=$clean_path
  export PATH
  real_codex=$(command -v codex 2>/dev/null || true)
fi

if [ -z "$real_codex" ]; then
  echo "Impala could not find the Codex executable." >&2
  exit 127
fi

export IMPALA_AGENT_PROVIDER=codex
remote="${IMPALA_CODEX_APP_SERVER:-}"
if [ -z "$remote" ]; then
  exec "$real_codex" "$@"
fi

# In --remote mode Codex only honors the terminal's directory when it is
# passed explicitly via --cd; otherwise the thread lands in the app server's
# own cwd. Inject --cd "$PWD" unless the user already chose a directory.
has_cd=false
for arg in "$@"; do
  case "$arg" in
    --) break ;;
    -C|--cd|--cd=*) has_cd=true; break ;;
  esac
done

expect_value=false
expect_resume_id=false
resume_session_id=""
for arg in "$@"; do
  if [ "$expect_value" = true ]; then
    expect_value=false
    continue
  fi
  case "$arg" in
    --) break ;;
    -c|--config|--enable|--disable|--remote|--remote-auth-token-env|-i|--image|-m|--model|--local-provider|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval)
      expect_value=true
      ;;
    exec|e|review|login|logout|mcp|plugin|mcp-server|app-server|remote-control|app|completion|update|doctor|sandbox|debug|execpolicy|apply|a|archive|delete|migrate-rollouts|unarchive|cloud|cloud-tasks|responses-api-proxy|stdio-to-uds|exec-server|features|help)
      exec "$real_codex" "$@"
      ;;
    resume) expect_resume_id=true ;;
    -*) ;;
    *)
      if [ "$expect_resume_id" = true ]; then
        resume_session_id="$arg"
      fi
      break
      ;;
  esac
done

has_explicit_remote=false
for arg in "$@"; do
  case "$arg" in
    --) break ;;
    --remote|--remote=*) has_explicit_remote=true ;;
  esac
done

if [ "$has_explicit_remote" = true ]; then
  exec "$real_codex" "$@"
fi

if [ -n "${IMPALA_HOOK_PORT:-}" ] &&
   [ -n "${IMPALA_WORKTREE_PATH:-}" ] &&
   [ -n "${IMPALA_PANE_ID:-}" ]; then
  while :; do
    launch_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      "http://127.0.0.1:${IMPALA_HOOK_PORT}/codex/launch" \
      --url-query "worktree_path=${IMPALA_WORKTREE_PATH}" \
      --url-query "pane_id=${IMPALA_PANE_ID}" \
      --url-query "session_id=${resume_session_id}" \
      --connect-timeout 1 --max-time 2 || true)
    [ "$launch_status" = "409" ] || break
    sleep 0.1
  done
fi

# This list follows Codex's current command surface. A future subcommand is
# treated as a prompt until it is added above; replace this shim when Codex
# exposes a native default-remote setting.
if [ "$has_cd" = true ]; then
  exec "$real_codex" --remote "$remote" "$@"
fi
exec "$real_codex" --remote "$remote" --cd "$PWD" "$@"
"#;

#[allow(dead_code)]
pub struct WrapperPaths {
    pub root: PathBuf,
    pub zsh_dir: PathBuf,
    pub bash_rcfile: PathBuf,
    pub fish_init_command: String,
}

/// Compute and create-if-missing the wrapper directory layout.
/// `app_data_dir` is typically `~/Library/Application Support/be.kodeus.impala`.
pub fn ensure_wrappers(app_data_dir: &Path) -> Result<WrapperPaths> {
    let root = app_data_dir.join("shell-wrappers");
    let bin_dir = root.join("bin");
    let zsh_dir = root.join("zsh");
    let bash_dir = root.join("bash");
    fs::create_dir_all(&bin_dir).context("create shell-wrappers/bin")?;
    fs::create_dir_all(&zsh_dir).context("create shell-wrappers/zsh")?;
    fs::create_dir_all(&bash_dir).context("create shell-wrappers/bash")?;

    write_executable_if_changed(&bin_dir.join("codex"), CODEX_WRAPPER)?;
    write_zsh_wrappers(&zsh_dir, &bin_dir)?;
    let bash_rcfile = bash_dir.join("rcfile");
    write_if_changed(&bash_rcfile, &build_bash_rcfile(&bin_dir))?;

    let fish_init_command = build_fish_init_command();

    Ok(WrapperPaths {
        root,
        zsh_dir,
        bash_rcfile,
        fish_init_command,
    })
}

fn write_zsh_wrappers(zsh_dir: &Path, bin_dir: &Path) -> Result<()> {
    let zshenv = format!(
        r#"# Impala zsh env wrapper
_impala_orig="${{IMPALA_ORIG_ZDOTDIR:-$HOME}}"
ZDOTDIR="$_impala_orig"
[[ -f "$_impala_orig/.zshenv" ]] && source "$_impala_orig/.zshenv"
ZDOTDIR={zsh_dir}
"#,
        zsh_dir = quote_for_shell(zsh_dir.to_str().unwrap_or("")),
    );
    write_if_changed(&zsh_dir.join(".zshenv"), &zshenv)?;

    let zprofile = format!(
        r#"# Impala zsh profile wrapper
_impala_orig="${{IMPALA_ORIG_ZDOTDIR:-$HOME}}"
ZDOTDIR="$_impala_orig"
[[ -f "$_impala_orig/.zprofile" ]] && source "$_impala_orig/.zprofile"
ZDOTDIR={zsh_dir}
"#,
        zsh_dir = quote_for_shell(zsh_dir.to_str().unwrap_or("")),
    );
    write_if_changed(&zsh_dir.join(".zprofile"), &zprofile)?;

    let zshrc = format!(
        r#"# Impala zsh rc wrapper
_impala_orig="${{IMPALA_ORIG_ZDOTDIR:-$HOME}}"
ZDOTDIR="$_impala_orig"
[[ -f "$_impala_orig/.zshrc" ]] && source "$_impala_orig/.zshrc"
ZDOTDIR={zsh_dir}
"#,
        zsh_dir = quote_for_shell(zsh_dir.to_str().unwrap_or("")),
    );
    write_if_changed(&zsh_dir.join(".zshrc"), &zshrc)?;

    let zlogin = format!(
        r#"# Impala zsh login wrapper
_impala_orig="${{IMPALA_ORIG_ZDOTDIR:-$HOME}}"
ZDOTDIR="$_impala_orig"
if [[ -o interactive ]]; then
  [[ -f "$_impala_orig/.zlogin" ]] && source "$_impala_orig/.zlogin"
fi
{hook}
export PATH={bin_dir}:$PATH
codex() {{
  {codex_wrapper} "$@"
}}
ZDOTDIR={zsh_dir}
"#,
        hook = ZSH_133_HOOK,
        bin_dir = quote_for_shell(bin_dir.to_str().unwrap_or("")),
        codex_wrapper = quote_for_shell(bin_dir.join("codex").to_str().unwrap_or("")),
        zsh_dir = quote_for_shell(zsh_dir.to_str().unwrap_or("")),
    );
    write_if_changed(&zsh_dir.join(".zlogin"), &zlogin)?;
    Ok(())
}

fn build_bash_rcfile(bin_dir: &Path) -> String {
    format!(
        r#"# Impala bash rcfile wrapper
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
{hook}
export PATH={bin_dir}:$PATH
"#,
        hook = BASH_133_HOOK,
        bin_dir = quote_for_shell(bin_dir.to_str().unwrap_or("")),
    )
}

fn build_fish_init_command() -> String {
    FISH_133_HOOK.replace('\n', "; ")
}

fn quote_for_shell(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn write_if_changed(path: &Path, contents: &str) -> Result<()> {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == contents {
            return Ok(());
        }
    }
    let mut f = fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    f.write_all(contents.as_bytes())
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

fn write_executable_if_changed(path: &Path, contents: &str) -> Result<()> {
    write_if_changed(path, contents)?;
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::process::Command;
    use tempfile::TempDir;

    #[test]
    fn ensure_wrappers_writes_all_zsh_files() {
        let tmp = TempDir::new().unwrap();
        let paths = ensure_wrappers(tmp.path()).unwrap();
        for f in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            assert!(paths.zsh_dir.join(f).exists(), "{f} missing");
        }
        assert!(paths.bash_rcfile.exists());
        assert!(paths.root.join("bin/codex").exists());
    }

    #[test]
    fn zlogin_contains_osc_133_emit() {
        let tmp = TempDir::new().unwrap();
        let paths = ensure_wrappers(tmp.path()).unwrap();
        let zlogin = fs::read_to_string(paths.zsh_dir.join(".zlogin")).unwrap();
        assert!(zlogin.contains(r#"printf "\033]133;A\007""#));
        assert!(zlogin.contains("precmd_functions"));
    }

    #[test]
    fn idempotent_second_call_does_not_rewrite() {
        let tmp = TempDir::new().unwrap();
        ensure_wrappers(tmp.path()).unwrap();
        let mtime_before = fs::metadata(tmp.path().join("shell-wrappers/zsh/.zshrc"))
            .unwrap()
            .modified()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        ensure_wrappers(tmp.path()).unwrap();
        let mtime_after = fs::metadata(tmp.path().join("shell-wrappers/zsh/.zshrc"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "zshrc was rewritten unnecessarily"
        );
    }

    #[cfg(unix)]
    fn run_codex_wrapper_in(args: &[&str], remote: Option<&str>, cwd: &Path) -> Vec<String> {
        let tmp = TempDir::new().unwrap();
        let paths = ensure_wrappers(tmp.path()).unwrap();
        let real_codex = tmp.path().join("real-codex");
        write_executable_if_changed(
            &real_codex,
            "#!/bin/sh\nprintf '%s\\n' \"$IMPALA_AGENT_PROVIDER\"\nprintf '%s\\n' \"$@\"\n",
        )
        .unwrap();

        let mut command = Command::new(paths.root.join("bin/codex"));
        command
            .args(args)
            .current_dir(cwd)
            .env("IMPALA_CODEX_BIN", real_codex)
            .env_remove("IMPALA_CODEX_APP_SERVER");
        if let Some(remote) = remote {
            command.env("IMPALA_CODEX_APP_SERVER", remote);
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "{:?}", output);
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[cfg(unix)]
    fn run_codex_wrapper(args: &[&str], remote: Option<&str>) -> Vec<String> {
        run_codex_wrapper_in(args, remote, Path::new("/"))
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_routes_interactive_sessions_to_the_managed_server() {
        let remote = "unix:///tmp/impala-codex.sock";
        assert_eq!(
            run_codex_wrapper(&["--yolo"], Some(remote)),
            ["codex", "--remote", remote, "--cd", "/", "--yolo"]
        );
        assert_eq!(
            run_codex_wrapper(&["resume", "session-1"], Some(remote)),
            [
                "codex",
                "--remote",
                remote,
                "--cd",
                "/",
                "resume",
                "session-1"
            ]
        );
        assert_eq!(
            run_codex_wrapper(&["fork", "--last"], Some(remote)),
            ["codex", "--remote", remote, "--cd", "/", "fork", "--last"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_sends_the_terminal_directory_to_the_managed_server() {
        let remote = "unix:///tmp/impala-codex.sock";
        assert_eq!(
            run_codex_wrapper_in(&["--yolo"], Some(remote), Path::new("/private/tmp")),
            [
                "codex",
                "--remote",
                remote,
                "--cd",
                "/private/tmp",
                "--yolo"
            ]
        );
        assert_eq!(
            run_codex_wrapper(&["--cd", "/elsewhere", "--yolo"], Some(remote)),
            ["codex", "--remote", remote, "--cd", "/elsewhere", "--yolo"]
        );
        assert_eq!(
            run_codex_wrapper(&["-C", "/elsewhere"], Some(remote)),
            ["codex", "--remote", remote, "-C", "/elsewhere"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_announces_the_source_pane_before_a_managed_launch() {
        let tmp = TempDir::new().unwrap();
        let paths = ensure_wrappers(tmp.path()).unwrap();
        let worktree = tmp.path().join("worktree");
        let tools = tmp.path().join("tools");
        let curl_log = tmp.path().join("curl.log");
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir_all(&tools).unwrap();

        let real_codex = tmp.path().join("real-codex");
        write_executable_if_changed(&real_codex, "#!/bin/sh\nexit 0\n").unwrap();
        write_executable_if_changed(
            &tools.join("curl"),
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$IMPALA_CURL_LOG\"\n",
        )
        .unwrap();

        let path = std::env::join_paths(std::iter::once(tools).chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        )))
        .unwrap();
        let output = Command::new(paths.root.join("bin/codex"))
            .args(["--yolo", "resume", "session-1"])
            .current_dir(&worktree)
            .env("PATH", path)
            .env("IMPALA_CODEX_BIN", real_codex)
            .env("IMPALA_CODEX_APP_SERVER", "unix:///tmp/impala-codex.sock")
            .env("IMPALA_HOOK_PORT", "60158")
            .env("IMPALA_WORKTREE_PATH", &worktree)
            .env("IMPALA_PANE_ID", "terminal-1")
            .env("IMPALA_CURL_LOG", &curl_log)
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);

        let request = fs::read_to_string(curl_log).unwrap();
        assert!(request.contains("http://127.0.0.1:60158/codex/launch"));
        assert!(request.contains(&format!("worktree_path={}", worktree.display())));
        assert!(request.contains("pane_id=terminal-1"));
        assert!(request.contains("session_id=session-1"));
    }

    #[cfg(unix)]
    #[test]
    fn zsh_keeps_the_codex_wrapper_after_path_reordering() {
        let tmp = TempDir::new().unwrap();
        let paths = ensure_wrappers(tmp.path()).unwrap();
        let tools = tmp.path().join("tools");
        let invocation_log = tmp.path().join("invocation.log");
        let curl_log = tmp.path().join("curl.log");
        fs::create_dir_all(&tools).unwrap();

        let real_codex = tmp.path().join("real-codex");
        write_executable_if_changed(
            &real_codex,
            "#!/bin/sh\nprintf 'wrapped %s\\n' \"$*\" > \"$IMPALA_INVOCATION_LOG\"\n",
        )
        .unwrap();
        write_executable_if_changed(
            &tools.join("codex"),
            "#!/bin/sh\nprintf 'bypassed %s\\n' \"$*\" > \"$IMPALA_INVOCATION_LOG\"\n",
        )
        .unwrap();
        write_executable_if_changed(
            &tools.join("curl"),
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$IMPALA_CURL_LOG\"\n",
        )
        .unwrap();

        let output = Command::new("/bin/zsh")
            .args([
                "-lic",
                "export PATH=\"$IMPALA_TEST_TOOLS:$PATH\"; codex --yolo",
            ])
            .env("HOME", tmp.path())
            .env("ZDOTDIR", &paths.zsh_dir)
            .env("IMPALA_ORIG_ZDOTDIR", tmp.path())
            .env("IMPALA_TEST_TOOLS", &tools)
            .env("IMPALA_CODEX_BIN", &real_codex)
            .env("IMPALA_CODEX_APP_SERVER", "unix:///tmp/impala-codex.sock")
            .env("IMPALA_HOOK_PORT", "60158")
            .env("IMPALA_WORKTREE_PATH", "/worktree")
            .env("IMPALA_PANE_ID", "terminal-1")
            .env("IMPALA_INVOCATION_LOG", &invocation_log)
            .env("IMPALA_CURL_LOG", &curl_log)
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);

        let invocation = fs::read_to_string(invocation_log).unwrap();
        assert!(invocation.starts_with("wrapped --remote "), "{invocation}");
        assert!(fs::read_to_string(curl_log)
            .unwrap()
            .contains("pane_id=terminal-1"));
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_preserves_explicit_remotes_and_non_interactive_commands() {
        let remote = "unix:///tmp/impala-codex.sock";
        assert_eq!(
            run_codex_wrapper(
                &["resume", "--remote", "ws://127.0.0.1:4222", "session-1"],
                Some(remote),
            ),
            [
                "codex",
                "resume",
                "--remote",
                "ws://127.0.0.1:4222",
                "session-1",
            ]
        );
        assert_eq!(
            run_codex_wrapper(&["--model", "gpt-5.6", "exec", "echo"], Some(remote)),
            ["codex", "--model", "gpt-5.6", "exec", "echo"]
        );
        assert_eq!(
            run_codex_wrapper(&["app-server", "daemon", "status"], Some(remote)),
            ["codex", "app-server", "daemon", "status"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_falls_back_to_the_normal_cli_without_a_managed_server() {
        assert_eq!(run_codex_wrapper(&["--yolo"], None), ["codex", "--yolo"]);
    }
}
