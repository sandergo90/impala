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
  file_name: string | null;
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
  file_name: string | null;
  original_text: string;
  highlight_source: string | null;
  body: string;
}

export type SplitNode =
  | { type: "leaf"; id: string; paneType: "agent" | "shell" }
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
  /** What to run inside the tab. Terminal = shell; Agent = `claude` command. */
  kind: "terminal" | "agent";
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
  agentLaunched: boolean;
  viewMode: "commit" | "all-changes" | "uncommitted";
  selectedCommit: CommitInfo | null;
  selectedFile: ChangedFile | null;
  /** Path (POSIX, worktree-relative) of the file currently shown in the Files viewer. Null when no file is open. */
  selectedFilePath: string | null;
  activePlanId: string | null;
  selectedPlanAnnotationId: string | null;
  /**
   * ID of the currently active tab inside the terminals pane.
   * `"tab-agent"` and `"tab-run"` refer to the system tabs. Any other
   * value is a user-tab ID from `userTabs`. On restore, if the ID no
   * longer resolves to a visible tab, `TabbedTerminals` falls back to
   * `"tab-agent"`.
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
  generatedFiles: string[];
  uncommittedStats: { additions: number; deletions: number };
  allChangesStats: { additions: number; deletions: number };
  annotations: Annotation[];
  plans: Plan[];
  planAnnotations: PlanAnnotation[];
  hasPendingPlan: boolean;
  agentStatus: "idle" | "working" | "permission";
  hasUnseenResult: boolean;
  /** GitHub PR status for this worktree's branch. Undefined until first fetched. */
  prStatus?: PrStatus;
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

export type PrState = "open" | "closed" | "merged";

export type ReviewDecision = "approved" | "changes_requested" | "review_required";

export type ChecksStatus = "success" | "failure" | "pending";

export interface ChecksRollup {
  status: ChecksStatus | null;
  passing: number;
  total: number;
}

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  reviewDecision: ReviewDecision | null;
  checks: ChecksRollup;
  additions: number;
  deletions: number;
  headBranch: string;
  headSha: string;
}

export type PrStatus =
  | { kind: "unsupported" }
  | { kind: "no_pr" }
  | ({ kind: "has_pr" } & PrInfo);

export interface GithubCliStatus {
  installed: boolean;
  authenticated: boolean;
  username: string | null;
}
