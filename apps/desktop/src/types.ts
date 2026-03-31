export interface Project {
  path: string;
  name: string;
}

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
  additions: number;
  deletions: number;
}

export interface ChangedFile {
  status: string;
  path: string;
}

export interface BranchInfo {
  name: string;
  is_remote: boolean;
}

export interface Annotation {
  id: string;
  repo_path: string;
  file_path: string;
  commit_hash: string;
  line_number: number;
  side: 'left' | 'right';
  body: string;
  resolved: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewAnnotation {
  repo_path: string;
  file_path: string;
  commit_hash: string;
  line_number: number;
  side: 'left' | 'right';
  body: string;
}

export type SplitNode =
  | { type: "leaf"; id: string; paneType: "claude" | "shell" }
  | {
      type: "split";
      orientation: "horizontal" | "vertical";
      ratio: number;
      first: SplitNode;
      second: SplitNode;
    };

export interface WorktreeNavState {
  activeTab: "terminal" | "diff" | "split";
  splitTree: SplitNode;
  focusedPaneId: string;
  claudeLaunched: boolean;
  viewMode: "commit" | "all-changes" | "uncommitted";
  selectedCommit: CommitInfo | null;
  selectedFile: ChangedFile | null;
}

export interface WorktreeDataState {
  paneSessions: Record<string, string>;
  commits: CommitInfo[];
  changedFiles: ChangedFile[];
  baseBranch: string | null;
  diffText: string | null;
  fileDiffs: Record<string, string>;
  fileDiffHashes: Record<string, string>;
  generatedFiles: string[];
  annotations: Annotation[];
  agentStatus: "idle" | "working";
}

export interface CommentProvider {
  list(repo: string, file?: string, commit?: string): Promise<Annotation[]>;
  create(annotation: NewAnnotation): Promise<Annotation>;
  update(id: string, changes: { body?: string; resolved?: boolean }): Promise<Annotation>;
  delete(id: string): Promise<void>;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  branch_name: string;
  status: string;
  url: string;
}

export interface WorktreeIssue {
  worktree_path: string;
  issue_id: string;
  identifier: string;
  created_at: string;
}
