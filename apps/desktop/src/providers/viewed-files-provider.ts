import { invoke } from "@/lib/invoke";

export type ViewKind = "uncommitted" | "all-changes" | "commit" | "last-turn" | "agent-run";

export const viewedFilesProvider = {
  async check(
    worktreePath: string,
    viewKind: ViewKind,
    contentRef: string | null,
    filePaths: string[],
  ): Promise<string[]> {
    return invoke<string[]>("check_viewed_files", {
      worktreePath,
      viewKind,
      commitHash: contentRef,
      filePaths,
    });
  },
  async set(
    worktreePath: string,
    viewKind: ViewKind,
    contentRef: string | null,
    filePath: string,
  ): Promise<void> {
    await invoke("set_file_viewed", {
      worktreePath,
      viewKind,
      commitHash: contentRef,
      filePath,
    });
  },
  async unset(worktreePath: string, filePath: string): Promise<void> {
    await invoke("unset_file_viewed", { worktreePath, filePath });
  },
  async setMany(
    worktreePath: string,
    viewKind: ViewKind,
    contentRef: string | null,
    filePaths: string[],
  ): Promise<void> {
    await invoke("set_files_viewed", {
      worktreePath,
      viewKind,
      commitHash: contentRef,
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
