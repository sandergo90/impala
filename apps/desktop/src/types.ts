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

export interface WorktreeNavState {
  activeTab: 'terminal' | 'diff';
  showSplit: boolean;
  viewMode: 'commit' | 'all-changes' | 'uncommitted';
  selectedCommit: CommitInfo | null;
  selectedFile: ChangedFile | null;
}

export interface WorktreeDataState {
  ptySessionId: string | null;
  commits: CommitInfo[];
  changedFiles: ChangedFile[];
  baseBranch: string | null;
  diffText: string | null;
  fileDiffs: Record<string, string>;
  fileDiffHashes: Record<string, string>;
  annotations: Annotation[];
}

export interface CommentProvider {
  list(repo: string, file?: string, commit?: string): Promise<Annotation[]>;
  create(annotation: NewAnnotation): Promise<Annotation>;
  update(id: string, changes: { body?: string; resolved?: boolean }): Promise<Annotation>;
  delete(id: string): Promise<void>;
}
