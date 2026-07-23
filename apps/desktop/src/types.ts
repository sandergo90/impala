export interface Project {
  path: string;
  name: string;
}

export interface Worktree {
  path: string;
  branch: string;
  head_commit: string;
  title: string | null;
  is_primary: boolean;
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
  code_context?: string;
}

export interface NewAnnotation {
  repo_path: string;
  file_path: string;
  commit_hash: string;
  line_number: number;
  side: 'left' | 'right';
  body: string;
  code_context?: string;
}

export interface BrowserAnnotation {
  id: string;
  repo_path: string;
  url: string;
  selector: string;
  element: string;
  body: string;
  screenshot_path?: string | null;
  resolved: boolean;
  created_at: string;
  updated_at: string;
}

export interface Automation {
  id: string;
  repo_path: string;
  name: string;
  prompt: string;
  agent: "claude" | "codex";
  /** 5-field cron expression, evaluated in local time. */
  schedule: string;
  enabled: boolean;
  /** Unix seconds of the next fire. */
  next_run_at: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  /** Unix seconds of the slot this run covers. */
  scheduled_for: number;
  worktree_path?: string | null;
  /** Immutable Markdown snapshot supplied to the agent for this run. */
  instructions_path?: string | null;
  status: "pending" | "launched" | "completed" | "failed" | "aborted" | "skipped";
  error?: string | null;
  created_at: string;
}

export type TerminalLaunchProfile = "shell" | "agent";

/** What fills a single pane. The leaf's content is the source of truth for it. */
export type PaneContent =
  | { kind: "terminal"; launch: TerminalLaunchProfile }
  | { kind: "file"; path: string }
  | { kind: "browser"; url?: string };

export interface GroupTab {
  id: string;
  /** Persisted automatic/fallback label. */
  label: string;
  /** Explicit user rename. Always takes precedence over runtime titles. */
  userLabel?: string;
  content: PaneContent;
  createdAt: number;
  pinned?: boolean;
}

export type SplitNode =
  | { type: "group"; id: string; tabs: GroupTab[]; activeTabId: string }
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
  /**
   * The top-level surface. Terminal startup is described by `terminalLaunch`;
   * File is a static viewer; Browser is a native child webview.
   */
  kind: "terminal" | "file" | "browser";
  /** Initial process launched by a terminal tab. Live agent activity is runtime state. */
  terminalLaunch?: TerminalLaunchProfile;
  /** Display label shown on the tab. Auto-numbered at creation time (monotonic). */
  label: string;
  /** Explicit user rename. Always takes precedence over runtime titles. */
  userLabel?: string;
  /** Creation timestamp; stable ordering. */
  createdAt: number;
  /** Worktree-relative POSIX path; only set when kind === "file". */
  path?: string;
  /** Preview vs pinned semantics; only meaningful when kind === "file". */
  pinned?: boolean;
  /** Current URL; only set when kind === "browser". Persisted so the tab restores. */
  url?: string;
  /**
   * Recursive split tree of panes inside this tab; the leaves' `content` is
   * the source of truth for what each pane shows. Optional for backward
   * compatibility: when absent, `getEffectiveUserTabSplitTree` synthesizes a
   * single leaf (id `tab-user-${id}`) whose content is derived from `kind`,
   * `terminalLaunch`, and `path`/`url`.
   */
  splitTree?: SplitNode;
  /**
   * Id of the currently focused leaf inside `splitTree`. Optional; the
   * renderer falls back to the first leaf when absent or stale.
   */
  focusedPaneId?: string;
}

export interface WorktreeNavState {
  activeTab: "terminal" | "diff";
  agentLaunched: boolean;
  viewMode: "commit" | "all-changes" | "uncommitted" | "last-turn";
  selectedCommit: CommitInfo | null;
  selectedFile: ChangedFile | null;
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
  /**
   * Split tree for the synthesized Agent system tab. The root leaf keeps id
   * `AGENT_PANE_ID` so the primary agent's PTY session is unchanged. Optional;
   * `getEffectiveAgentTabSplitTree` synthesizes a single agent leaf when
   * absent. Persisted. The Run tab stays unsplittable.
   */
  agentTabSplitTree?: SplitNode;
  /** Focused leaf id inside `agentTabSplitTree`. Persisted. */
  agentTabFocusedPaneId?: string;
  /**
   * Stack of previously-visited tab IDs in this worktree, most recent last.
   * Maintained automatically by `updateWorktreeNavState` whenever
   * `activeTerminalsTab` changes (callers can override by passing `tabHistory`
   * explicitly). Used by `closeUserTab` to jump back to the tab the user was
   * on before opening the one they just closed.
   */
  tabHistory: string[];
  /** Last observed exit code for the Run tab's PTY; null if never exited. */
  runExitCode: number | null;
  /** True when the Run script exited non-zero and the user has not yet viewed the Run tab. */
  hasUnreadRunFailure: boolean;
  /**
   * Stable id of the Action most recently fired in this worktree. The header's
   * play button and Cmd+Shift+R both fire this Action; the dropdown shows a
   * checkmark next to it. In-memory only — reset on app restart.
   */
  lastUsedActionId?: string | null;
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
  lastTurnStats: { additions: number; deletions: number };
  hasLastTurnSnapshot: boolean;
  annotations: Annotation[];
  agentStatus: "idle" | "working" | "permission";
  /** Live agent activity keyed by terminal pane id. */
  agentPaneStatuses: Record<string, "working" | "permission">;
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

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  branch_name: string;
  status: string;
  url: string;
}

export type IssueTrackerKind = "linear" | "jira" | "none";

export interface IssueTrackerInfo {
  tracker: IssueTrackerKind;
  configured: boolean;
}

export interface WorktreeIssue {
  worktree_path: string;
  issue_id: string;
  identifier: string;
  provider: string;
  url: string;
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

export interface BitbucketCliStatus {
  installed: boolean;
  authenticated: boolean;
  username: string | null;
  authMethod: string | null;
  expires: string | null;
}

export interface Action {
  id: string;
  name: string;
  script: string;
}

export interface ProjectConfig {
  setup: string | null;
  teardown: string | null;
  actions: Action[];
}
