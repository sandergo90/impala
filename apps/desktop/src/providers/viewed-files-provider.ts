import { invoke } from "@tauri-apps/api/core";

export interface ViewedFile {
  worktree_path: string;
  commit_hash: string;
  file_path: string;
  patch_hash: string;
  viewed_at_commit: string | null;
  created_at: string;
}

export const viewedFilesProvider = {
  async list(worktreePath: string, commitHash: string): Promise<ViewedFile[]> {
    return invoke<ViewedFile[]>("list_viewed_files", {
      worktreePath,
      commitHash,
    });
  },
  async set(
    worktreePath: string,
    commitHash: string,
    filePath: string,
    patchHash: string,
    viewedAtCommit?: string | null,
  ): Promise<ViewedFile> {
    return invoke<ViewedFile>("set_file_viewed", {
      worktreePath,
      commitHash,
      filePath,
      patchHash,
      viewedAtCommit: viewedAtCommit ?? null,
    });
  },
  async unset(
    worktreePath: string,
    commitHash: string,
    filePath: string,
  ): Promise<void> {
    await invoke("unset_file_viewed", {
      worktreePath,
      commitHash,
      filePath,
    });
  },
  async clearForWorktree(worktreePath: string): Promise<void> {
    await invoke("clear_viewed_files", { worktreePath });
  },
};
