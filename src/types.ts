export interface Worktree {
  path: string;
  branch: string;
  head_commit: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}
