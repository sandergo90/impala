//! Generates wrapper rc files that source the user's real rc files and
//! emit the OSC 133;A prompt-start marker so the PTY daemon can detect
//! shell readiness.
//!
//! Reference: ../../../superset/apps/desktop/src/main/lib/agent-setup/shell-wrappers.ts

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

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
    let zsh_dir = root.join("zsh");
    let bash_dir = root.join("bash");
    fs::create_dir_all(&zsh_dir).context("create shell-wrappers/zsh")?;
    fs::create_dir_all(&bash_dir).context("create shell-wrappers/bash")?;

    write_zsh_wrappers(&zsh_dir)?;
    let bash_rcfile = bash_dir.join("rcfile");
    write_if_changed(&bash_rcfile, &build_bash_rcfile())?;

    let fish_init_command = build_fish_init_command();

    Ok(WrapperPaths {
        root,
        zsh_dir,
        bash_rcfile,
        fish_init_command,
    })
}

fn write_zsh_wrappers(zsh_dir: &Path) -> Result<()> {
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
ZDOTDIR={zsh_dir}
"#,
        hook = ZSH_133_HOOK,
        zsh_dir = quote_for_shell(zsh_dir.to_str().unwrap_or("")),
    );
    write_if_changed(&zsh_dir.join(".zlogin"), &zlogin)?;
    Ok(())
}

fn build_bash_rcfile() -> String {
    format!(
        r#"# Impala bash rcfile wrapper
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
{hook}
"#,
        hook = BASH_133_HOOK,
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
    let mut f = fs::File::create(path)
        .with_context(|| format!("create {}", path.display()))?;
    f.write_all(contents.as_bytes())
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ensure_wrappers_writes_all_zsh_files() {
        let tmp = TempDir::new().unwrap();
        let paths = ensure_wrappers(tmp.path()).unwrap();
        for f in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            assert!(paths.zsh_dir.join(f).exists(), "{f} missing");
        }
        assert!(paths.bash_rcfile.exists());
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
        assert_eq!(mtime_before, mtime_after, "zshrc was rewritten unnecessarily");
    }
}
