export interface Project {
  path: string;
  name: string;
}

export interface Worktree {
  path: string;
  branch: string;
  head_commit: string;
  title: string | null;
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

export interface Plan {
  id: string;
  plan_path: string;
  worktree_path: string;
  title: string | null;
  status: "pending" | "approved" | "changes_requested" | "completed";
  version: number;
  content: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanFile {
  file_name: string;
  content: string;
}

export interface PlanAnnotation {
  id: string;
  plan_path: string;
  worktree_path: string;
  original_text: string;
  highlight_source: string | null;
  body: string;
  resolved: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewPlanAnnotation {
  plan_path: string;
  worktree_path: string;
  original_text: string;
  highlight_source: string | null;
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

export interface UserTab {
  /** Stable ID, used as the paneId key (`tab-user-${id}`) in single-leaf mode. Never reused. */
  id: string;
  /** What to run inside the tab. Terminal = shell; Claude = `claude` command. */
  kind: "terminal" | "claude";
  /** Display label shown on the tab. Auto-numbered at creation time (monotonic). */
  label: string;
  /** Creation timestamp; stable ordering. */
  createdAt: number;
  /**
   * Recursive split tree of panes inside this tab. Optional for backward
   * compatibility with tabs created before Phase 4: when absent, the
   * renderer synthesizes a single leaf with id `tab-user-${id}`.
   */
  splitTree?: SplitNode;
  /**
   * Id of the currently focused leaf inside `splitTree`. Optional; the
   * renderer falls back to the first leaf when absent or stale.
   */
  focusedPaneId?: string;
}

export interface WorktreeNavState {
  activeTab: "terminal" | "diff" | "split" | "plan";
  claudeLaunched: boolean;
  viewMode: "commit" | "all-changes" | "uncommitted";
  selectedCommit: CommitInfo | null;
  selectedFile: ChangedFile | null;
  activePlanId: string | null;
  selectedPlanAnnotationId: string | null;
  /**
   * ID of the currently active tab inside the terminals pane.
   * `"tab-claude"` and `"tab-run"` refer to the system tabs. Any other
   * value is a user-tab ID from `userTabs`. On restore, if the ID no
   * longer resolves to a visible tab, `TabbedTerminals` falls back to
   * `"tab-claude"`.
   */
  activeTerminalsTab: string;
  /** Timestamp (ms) when the setup script was last auto-run; null if never. */
  setupRanAt: number | null;
  /** Status of the user-configured run script in the Run tab. */
  runStatus: "idle" | "running" | "stopping";
  /** User-added tabs (plus button). Empty when the user hasn't created any. */
  userTabs: UserTab[];
  /** Last observed exit code for the Run tab's PTY; null if never exited. */
  runExitCode: number | null;
  /** True when the Run script exited non-zero and the user has not yet viewed the Run tab. */
  hasUnreadRunFailure: boolean;
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
  uncommittedStats: { additions: number; deletions: number };
  allChangesStats: { additions: number; deletions: number };
  annotations: Annotation[];
  plans: Plan[];
  planAnnotations: PlanAnnotation[];
  hasPendingPlan: boolean;
  agentStatus: "idle" | "working" | "permission";
  hasUnseenResult: boolean;
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
