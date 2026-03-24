mod git;

#[tauri::command]
fn list_worktrees(repo_path: String) -> Result<Vec<git::Worktree>, String> {
    git::list_worktrees(&repo_path)
}

#[tauri::command]
fn detect_base_branch(worktree_path: String) -> Result<String, String> {
    git::detect_base_branch(&worktree_path)
}

#[tauri::command]
fn get_diverged_commits(
    worktree_path: String,
    base_branch: Option<String>,
) -> Result<Vec<git::CommitInfo>, String> {
    git::get_diverged_commits(&worktree_path, base_branch)
}

#[tauri::command]
fn get_changed_files(
    worktree_path: String,
    commit_hash: String,
) -> Result<Vec<git::ChangedFile>, String> {
    git::get_changed_files(&worktree_path, &commit_hash)
}

#[tauri::command]
fn get_commit_diff(
    worktree_path: String,
    commit_hash: String,
    file_path: String,
) -> Result<String, String> {
    git::get_commit_diff(&worktree_path, &commit_hash, &file_path)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_worktrees,
            detect_base_branch,
            get_diverged_commits,
            get_changed_files,
            get_commit_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
