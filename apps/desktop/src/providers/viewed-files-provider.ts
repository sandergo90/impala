import { invoke } from "@tauri-apps/api/core";

export type ViewKind = "uncommitted" | "all-changes" | "commit";

export const viewedFilesProvider = {
  async check(
    worktreePath: string,
    viewKind: ViewKind,
    commitHash: string | null,
    filePaths: string[],
  ): Promise<string[]> {
    return invoke<string[]>("check_viewed_files", {
      worktreePath,
      viewKind,
      commitHash,
      filePaths,
    });
  },
  async set(
    worktreePath: string,
    viewKind: ViewKind,
    commitHash: string | null,
    filePath: string,
  ): Promise<void> {
    await invoke("set_file_viewed", {
      worktreePath,
      viewKind,
      commitHash,
      filePath,
    });
  },
  async unset(worktreePath: string, filePath: string): Promise<void> {
    await invoke("unset_file_viewed", { worktreePath, filePath });
  },
  async setMany(
    worktreePath: string,
    viewKind: ViewKind,
    commitHash: string | null,
    filePaths: string[],
  ): Promise<void> {
    await invoke("set_files_viewed", {
      worktreePath,
      viewKind,
      commitHash,
      filePaths,
    });
  },
  async unsetMany(worktreePath: string, filePaths: string[]): Promise<void> {
    await invoke("unset_files_viewed", { worktreePath, filePaths });
  },
  async clearForWorktree(worktreePath: string): Promise<void> {
    await invoke("clear_viewed_files", { worktreePath });
  },
};
