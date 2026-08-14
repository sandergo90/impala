import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@/lib/invoke";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { openFileInEditor } from "../lib/open-file-in-editor";
import { useCmdHeld } from "../hooks/useCmdClickCursor";
import { ChangedFileContextMenu } from "./ChangedFileContextMenu";
import type { AgentRunChanges, ChangedFile, CommitInfo, WorktreeNavState, WorktreeDataState } from "../types";
import { splitDiffByFile } from "../lib/diff-files";

// Same mapping the file tree uses (see `getTreesStyle` in themes/apply.ts): the
// status tokens are derived per-theme from the terminal palette, so added stays
// green and modified stays blue in both panels and in user-imported themes.
const statusColor: Record<string, string> = {
  A: "text-success", M: "text-info", D: "text-danger", R: "text-warning",
};

const AUTO_REFRESH_DELAY_MS = 750;
const WORKING_AGENT_AUTO_REFRESH_DELAY_MS = 2500;

// Stable empty/default references so the per-field store selectors below don't
// return a fresh value (and force a re-render) when a field is absent.
const EMPTY_COMMITS: CommitInfo[] = [];
const EMPTY_CHANGED_FILES: ChangedFile[] = [];
const ZERO_STATS = { additions: 0, deletions: 0 };

interface ChangedFileTreeDirectory {
  directories: Map<string, ChangedFileTreeDirectory>;
  files: ChangedFile[];
}

type ChangedFileTreeRow =
  | { kind: "directory"; depth: number; name: string; path: string }
  | { kind: "file"; depth: number; name: string; file: ChangedFile };

function buildChangedFileTreeRows(
  files: ChangedFile[],
  collapsedDirectories: Set<string>,
): ChangedFileTreeRow[] {
  const root: ChangedFileTreeDirectory = {
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      let child = directory.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), files: [] };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }

  const rows: ChangedFileTreeRow[] = [];
  const visit = (directory: ChangedFileTreeDirectory, path: string, depth: number) => {
    const childDirectories = [...directory.directories.entries()]
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [name, child] of childDirectories) {
      const childPath = path ? `${path}/${name}` : name;
      rows.push({ kind: "directory", depth, name, path: childPath });
      if (!collapsedDirectories.has(childPath)) {
        visit(child, childPath, depth + 1);
      }
    }

    const childFiles = [...directory.files]
      .sort((a, b) => a.path.localeCompare(b.path));
    for (const file of childFiles) {
      rows.push({
        kind: "file",
        depth,
        name: file.path.split("/").pop() ?? file.path,
        file,
      });
    }
  };

  visit(root, "", 0);
  return rows;
}

function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function sameStats(
  a: { additions: number; deletions: number },
  b: { additions: number; deletions: number },
): boolean {
  return a.additions === b.additions && a.deletions === b.deletions;
}

function sameChangedFiles(a: ChangedFile[], b: ChangedFile[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].status !== b[i].status) return false;
  }
  return true;
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameFileDiffs(a: Record<string, string>, b: Record<string, string>): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function statsKeyForMode(
  mode: WorktreeNavState["viewMode"],
): "uncommittedStats" | "allChangesStats" | "lastTurnStats" | null {
  if (mode === "uncommitted") return "uncommittedStats";
  if (mode === "all-changes") return "allChangesStats";
  if (mode === "last-turn") return "lastTurnStats";
  return null;
}

interface CommitPanelProps {
  variant?: "sidebar" | "popover";
  onSelection?: () => void;
  onRevealInFiles?: () => void;
}

export function CommitPanel({
  variant = "sidebar",
  onSelection,
  onRevealInFiles,
}: CommitPanelProps) {
  const isPopover = variant === "popover";
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path;

  // Subscribe to each field individually so unrelated nav/data updates
  // (e.g. agentStatus toggling while the agent works) don't re-render the whole
  // panel. Selecting the parent object would create a new reference on every
  // updateWorktreeDataState call. Mirrors the pattern in DiffView.
  const baseBranch = useDataStore((s) => wtPath ? s.worktreeDataStates[wtPath]?.baseBranch ?? null : null);
  const commits = useDataStore((s) => wtPath ? s.worktreeDataStates[wtPath]?.commits ?? EMPTY_COMMITS : EMPTY_COMMITS);
  const selectedCommit = useUIStore((s) => wtPath ? s.worktreeNavStates[wtPath]?.selectedCommit ?? null : null);
  const changedFiles = useDataStore((s) => wtPath ? s.worktreeDataStates[wtPath]?.changedFiles ?? EMPTY_CHANGED_FILES : EMPTY_CHANGED_FILES);
  const selectedFile = useUIStore((s) => wtPath ? s.worktreeNavStates[wtPath]?.selectedFile ?? null : null);
  const viewMode = useUIStore((s) => wtPath ? s.worktreeNavStates[wtPath]?.viewMode ?? 'commit' : 'commit');
  const selectedAgentRun = useUIStore((s) => wtPath ? s.worktreeNavStates[wtPath]?.selectedAgentRun ?? null : null);
  const uncommittedStats = useDataStore((s) => wtPath ? s.worktreeDataStates[wtPath]?.uncommittedStats ?? ZERO_STATS : ZERO_STATS);
  const allChangesStats = useDataStore((s) => wtPath ? s.worktreeDataStates[wtPath]?.allChangesStats ?? ZERO_STATS : ZERO_STATS);
  const lastTurnStats = useDataStore((s) => wtPath ? s.worktreeDataStates[wtPath]?.lastTurnStats ?? ZERO_STATS : ZERO_STATS);
  const hasLastTurnSnapshot = useDataStore((s) => wtPath ? s.worktreeDataStates[wtPath]?.hasLastTurnSnapshot ?? false : false);
  const hasWorktreeState = useUIStore((s) => wtPath ? s.worktreeNavStates[wtPath] != null : false);
  const hasWorktreeData = useDataStore((s) => wtPath ? s.worktreeDataStates[wtPath] != null : false);

  const cmdHeld = useCmdHeld();
  const worktreePath = wtPath ?? "";
  const autoRefreshTimerRef = useRef<number | null>(null);
  const autoRefreshDeadlineRef = useRef(Infinity);
  const autoRefreshInFlightRef = useRef(false);
  const autoRefreshQueuedRef = useRef(false);
  const selectionRequestRef = useRef(0);
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(
    () => new Set(),
  );
  const changedFileRows = useMemo(
    () => buildChangedFileTreeRows(changedFiles, collapsedDirectories),
    [changedFiles, collapsedDirectories],
  );

  // Virtualize the changed-files list: a large diff can have hundreds of files,
  // and rendering every tree row (with a context menu for each file) is the
  // slowest part of this panel. Only visible rows plus a small buffer hit the DOM.
  const filesScrollRef = useRef<HTMLDivElement>(null);
  const filesVirtualizer = useVirtualizer({
    count: changedFileRows.length,
    getScrollElement: () => filesScrollRef.current,
    estimateSize: () => 30,
    overscan: 12,
  });

  const updateNav = useCallback((updates: Partial<WorktreeNavState>) =>
    useUIStore.getState().updateWorktreeNavState(worktreePath, updates),
    [worktreePath]
  );

  const updateData = useCallback((updates: Partial<WorktreeDataState>) =>
    useDataStore.getState().updateWorktreeDataState(worktreePath, updates),
    [worktreePath]
  );

  const clearScheduledAutoRefresh = useCallback(() => {
    if (autoRefreshTimerRef.current !== null) {
      window.clearTimeout(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = null;
      autoRefreshDeadlineRef.current = Infinity;
    }
  }, []);

  const loadGeneratedFiles = useCallback(async (files: ChangedFile[]): Promise<string[]> => {
    const current = useDataStore.getState().getWorktreeDataState(worktreePath);
    if (sameChangedFiles(current.changedFiles, files)) {
      return current.generatedFiles;
    }
    return invoke<string[]>("check_generated_files", {
      worktreePath,
      files: files.map(f => f.path),
    });
  }, [worktreePath]);

  const loadDiffPayload = useCallback(async (
    mode: WorktreeNavState["viewMode"],
    commit?: CommitInfo,
  ): Promise<{ files: ChangedFile[]; fullDiff: string; generatedFiles: string[] }> => {
    let files: ChangedFile[];
    let fullDiff: string;

    if (mode === "uncommitted") {
      [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_uncommitted_files", { worktreePath }),
        invoke<string>("get_uncommitted_diff", { worktreePath }),
      ]);
    } else if (mode === "last-turn") {
      [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_last_turn_files", { worktreePath }),
        invoke<string>("get_last_turn_diff", { worktreePath }),
      ]);
    } else if (mode === "agent-run") {
      const agentRun = useUIStore
        .getState()
        .getWorktreeNavState(worktreePath).selectedAgentRun;
      if (!agentRun) throw new Error("Missing agent run");
      const changes = await invoke<AgentRunChanges | null>("get_agent_run_changes", {
        worktreePath,
        paneId: agentRun.paneId,
      });
      if (!changes) throw new Error("Changes for this agent run are unavailable");
      files = changes.changed_files;
      fullDiff = changes.diff;
    } else if (mode === "all-changes") {
      [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_all_changed_files", { worktreePath }),
        invoke<string>("get_full_branch_diff", { worktreePath }),
      ]);
    } else {
      if (!commit) throw new Error("Missing commit for commit diff");
      [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_changed_files", { worktreePath, commitHash: commit.hash }),
        invoke<string>("get_full_commit_diff", { worktreePath, commitHash: commit.hash }),
      ]);
    }

    const generatedFiles = await loadGeneratedFiles(files);
    return { files, fullDiff, generatedFiles };
  }, [loadGeneratedFiles, worktreePath]);

  const applyDiffPayload = useCallback((
    mode: WorktreeNavState["viewMode"],
    payload: { files: ChangedFile[]; fullDiff: string; generatedFiles: string[] },
    force = false,
  ) => {
    const fileDiffs = splitDiffByFile(payload.fullDiff);
    const stats = countDiffStats(payload.fullDiff);
    const current = useDataStore.getState().getWorktreeDataState(worktreePath);
    const updates: Partial<WorktreeDataState> = {};

    if (force || !sameChangedFiles(current.changedFiles, payload.files)) {
      updates.changedFiles = payload.files;
    }
    if (force || !sameFileDiffs(current.fileDiffs, fileDiffs)) {
      updates.fileDiffs = fileDiffs;
    }
    if (force || !sameStringArray(current.generatedFiles, payload.generatedFiles)) {
      updates.generatedFiles = payload.generatedFiles;
    }

    const statsKey = statsKeyForMode(mode);
    if (statsKey && (force || !sameStats(current[statsKey], stats))) {
      updates[statsKey] = stats;
    }

    if (Object.keys(updates).length > 0) {
      updateData(updates);
    }
  }, [updateData, worktreePath]);

  const selectAllChanges = async () => {
    const requestId = ++selectionRequestRef.current;
    clearScheduledAutoRefresh();
    updateNav({ viewMode: 'all-changes', selectedCommit: null, selectedFile: null, activeTab: 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, generatedFiles: [] });
    onSelection?.();
    try {
      const payload = await loadDiffPayload("all-changes");
      if (selectionRequestRef.current !== requestId) return;
      applyDiffPayload("all-changes", payload, true);
    } catch (e) {
      toast.error("Failed to load changed files");
    }
  };

  const selectLastTurn = async () => {
    const requestId = ++selectionRequestRef.current;
    clearScheduledAutoRefresh();
    updateNav({ viewMode: 'last-turn', selectedCommit: null, selectedFile: null, activeTab: 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, generatedFiles: [] });
    try {
      const payload = await loadDiffPayload("last-turn");
      if (selectionRequestRef.current !== requestId) return;
      applyDiffPayload("last-turn", payload, true);
    } catch (e) {
      toast.error("Failed to load last turn changes");
    }
  };

  const selectAgentRun = async () => {
    if (!selectedAgentRun) return;
    const requestId = ++selectionRequestRef.current;
    clearScheduledAutoRefresh();
    updateNav({ viewMode: 'agent-run', selectedCommit: null, selectedFile: null, activeTab: 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, generatedFiles: [] });
    onSelection?.();
    try {
      const payload = await loadDiffPayload("agent-run");
      if (selectionRequestRef.current !== requestId) return;
      applyDiffPayload("agent-run", payload, true);
    } catch {
      toast.error("Failed to load agent changes");
    }
  };

  const selectUncommitted = async () => {
    const requestId = ++selectionRequestRef.current;
    clearScheduledAutoRefresh();
    updateNav({ viewMode: 'uncommitted', selectedCommit: null, selectedFile: null, activeTab: 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, generatedFiles: [] });
    onSelection?.();
    try {
      const payload = await loadDiffPayload("uncommitted");
      if (selectionRequestRef.current !== requestId) return;
      applyDiffPayload("uncommitted", payload, true);
    } catch (e) {
      toast.error("Failed to load uncommitted changes");
    }
  };

  const selectCommit = async (commit: CommitInfo) => {
    const requestId = ++selectionRequestRef.current;
    clearScheduledAutoRefresh();
    updateNav({ viewMode: 'commit', selectedCommit: commit, selectedFile: null, activeTab: 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, generatedFiles: [] });
    try {
      const payload = await loadDiffPayload("commit", commit);
      if (selectionRequestRef.current !== requestId) return;
      applyDiffPayload("commit", payload, true);
    } catch (e) {
      toast.error("Failed to load commit");
    }
  };

  const selectFile = (file: ChangedFile) => {
    updateNav({ selectedFile: file });
    const currentFileDiffs = useDataStore.getState().getWorktreeDataState(worktreePath).fileDiffs;
    const diff = currentFileDiffs[file.path] ?? "";
    updateData({ diffText: diff });
    onSelection?.();
  };

  // Auto-refresh when files or git refs change on disk
  const refreshCurrentView = useCallback(async () => {
    if (!worktreePath) return;

    // Keep selectedWorktree.head_commit in sync with actual HEAD
    try {
      const headCommit = await invoke<string>("get_head_commit", { worktreePath });
      const current = useUIStore.getState().selectedWorktree;
      if (current && current.path === worktreePath && current.head_commit !== headCommit) {
        useUIStore.getState().setSelectedWorktree({ ...current, head_commit: headCommit });
      }
    } catch {
      // Silently fail
    }

    // Always refresh commit list so sidebar counts stay accurate.
    // Skip the store update if the list is unchanged to avoid churning
    // downstream re-renders (which can flicker the diff panel).
    const currentData = useDataStore.getState().getWorktreeDataState(worktreePath);
    const currentBaseBranch = currentData.baseBranch;
    const currentViewMode = useUIStore.getState().getWorktreeNavState(worktreePath).viewMode;

    if (currentBaseBranch) {
      try {
        const nextCommits = await invoke<CommitInfo[]>("get_diverged_commits", { worktreePath, baseBranch: currentBaseBranch });
        const prev = useDataStore.getState().getWorktreeDataState(worktreePath).commits;
        const sameLen = prev.length === nextCommits.length;
        const sameHashes = sameLen && prev.every((c, i) => c.hash === nextCommits[i].hash);
        if (!sameHashes) {
          updateData({ commits: nextCommits });
        }
      } catch {
        // Silently fail on auto-refresh
      }
    }

    // Committed diffs are immutable, so skip the refetch.
    if (currentViewMode === 'commit') {
      return;
    }

    try {
      const payload = await loadDiffPayload(currentViewMode);
      const latestMode = useUIStore.getState().getWorktreeNavState(worktreePath).viewMode;
      if (latestMode !== currentViewMode) return;
      applyDiffPayload(currentViewMode, payload);
    } catch {
      // Silently fail on auto-refresh
    }
  }, [applyDiffPayload, loadDiffPayload, updateData, worktreePath]);

  // Keep the +/- counts on the section buttons (Last Turn, Uncommitted, All
  // Changes) fresh for the sections that aren't currently selected —
  // refreshCurrentView only updates the active one. Without this, a section's
  // stats stay stale until it's clicked.
  const refreshSectionStats = useCallback(async () => {
    if (!worktreePath) return;
    const mode = useUIStore.getState().getWorktreeNavState(worktreePath).viewMode;
    const hasSnapshot = useDataStore.getState().getWorktreeDataState(worktreePath).hasLastTurnSnapshot;

    const fetchStat = async (
      command: string,
      key: "uncommittedStats" | "allChangesStats" | "lastTurnStats",
    ): Promise<void> => {
      try {
        const diff = await invoke<string>(command, { worktreePath });
        const stats = countDiffStats(diff);
        const current = useDataStore.getState().getWorktreeDataState(worktreePath);
        if (!sameStats(current[key], stats)) {
          const updates: Partial<WorktreeDataState> = {};
          updates[key] = stats;
          updateData(updates);
        }
      } catch {
        // Silently fail on auto-refresh
      }
    };

    const jobs: Promise<void>[] = [];
    if (mode !== "uncommitted") jobs.push(fetchStat("get_uncommitted_diff", "uncommittedStats"));
    if (mode !== "all-changes") jobs.push(fetchStat("get_full_branch_diff", "allChangesStats"));
    if (mode !== "last-turn" && hasSnapshot) jobs.push(fetchStat("get_last_turn_diff", "lastTurnStats"));
    await Promise.all(jobs);
  }, [worktreePath, updateData]);

  const runAutoRefresh = useCallback(async () => {
    if (autoRefreshInFlightRef.current) {
      autoRefreshQueuedRef.current = true;
      return;
    }

    autoRefreshInFlightRef.current = true;
    try {
      do {
        autoRefreshQueuedRef.current = false;
        await Promise.all([refreshCurrentView(), refreshSectionStats()]);
      } while (autoRefreshQueuedRef.current);
    } finally {
      autoRefreshInFlightRef.current = false;
    }
  }, [refreshCurrentView, refreshSectionStats]);

  const scheduleAutoRefresh = useCallback((delay = AUTO_REFRESH_DELAY_MS) => {
    // Earliest deadline wins: a later event must not push back an already
    // scheduled refresh, or sustained fs churn (an agent writing files) would
    // starve the panel until the activity pauses.
    const deadline = Date.now() + delay;
    if (autoRefreshTimerRef.current !== null) {
      if (deadline >= autoRefreshDeadlineRef.current) return;
      window.clearTimeout(autoRefreshTimerRef.current);
    }
    autoRefreshDeadlineRef.current = deadline;
    autoRefreshTimerRef.current = window.setTimeout(() => {
      autoRefreshTimerRef.current = null;
      autoRefreshDeadlineRef.current = Infinity;
      void runAutoRefresh();
    }, delay);
  }, [runAutoRefresh]);

  useEffect(() => {
    if (!worktreePath) return;
    void runAutoRefresh();
    invoke<boolean>("has_last_turn_snapshot", { worktreePath })
      .then((has) => updateData({ hasLastTurnSnapshot: has }))
      .catch(() => { /* ignore */ });
  }, [worktreePath, runAutoRefresh, updateData]);

  useEffect(() => {
    if (!worktreePath) return;
    const safeId = worktreePath.replace(/[^a-zA-Z0-9\-_]/g, "-");
    let unlisten: (() => void) | null = null;

    listen(`fs-changed-${safeId}`, () => {
      // Invalidate branch cache so next "All Changes" fetch is fresh
      void invoke("invalidate_branch_cache", { worktreePath });
      // This panel only mounts while the sidebar's Changes tab is visible, so
      // always refresh — even on the terminal tab, the commit list and stats
      // shown here would otherwise go stale. But relax the cadence when the
      // diff view is hidden (terminal tab) or an agent is churning files.
      const tab = useUIStore.getState().getWorktreeNavState(worktreePath)?.activeTab;
      const agentStatus = useDataStore.getState().getWorktreeDataState(worktreePath).agentStatus;
      scheduleAutoRefresh(
        agentStatus === "working" || tab === "terminal"
          ? WORKING_AGENT_AUTO_REFRESH_DELAY_MS
          : AUTO_REFRESH_DELAY_MS,
      );
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      clearScheduledAutoRefresh();
      unlisten?.();
    };
  }, [clearScheduledAutoRefresh, scheduleAutoRefresh, worktreePath]);

  useEffect(() => {
    if (!worktreePath) return;
    let unlisten: (() => void) | null = null;
    listen<{ worktree_path: string }>("last-turn-snapshot-changed", (e) => {
      if (e.payload.worktree_path !== worktreePath) return;
      updateData({ hasLastTurnSnapshot: true });
      const currentMode = useUIStore.getState().getWorktreeNavState(worktreePath).viewMode;
      if (currentMode === 'last-turn') {
        scheduleAutoRefresh(0);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [worktreePath, scheduleAutoRefresh, updateData]);

  if (!selectedWorktree || (!hasWorktreeState && !hasWorktreeData)) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a worktree
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full text-sm overflow-hidden">
      {/* Commits section — top half */}
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex items-center gap-1.5 px-3.5 py-2.5 text-sm uppercase tracking-[1.2px] text-muted-foreground font-semibold shrink-0 border-b border-border">
          Commits on <span className="font-mono text-sm text-muted-foreground normal-case tracking-normal">{selectedWorktree.branch}</span>
          {commits.length > 0 && (
            <span className="ml-auto text-sm bg-accent rounded-full px-1.5 py-0.5 text-muted-foreground normal-case tracking-normal font-normal">{commits.length}</span>
          )}
        </div>

        <div className="overflow-y-auto flex-1 min-h-0">
        {selectedAgentRun ? (
          <button
            autoFocus={isPopover && viewMode === "agent-run"}
            onClick={selectAgentRun}
            className={`w-full px-3.5 py-2 text-left transition-colors border-b border-border ${
              viewMode === "agent-run"
                ? "bg-primary/12"
                : "hover:bg-accent"
            }`}
          >
            <div className={`text-sm font-medium ${viewMode === "agent-run" ? "text-foreground" : "text-muted-foreground"}`}>
              {selectedAgentRun.label}
            </div>
            <div className="mt-0.5 text-sm text-muted-foreground/90">
              Changes during this agent run
            </div>
          </button>
        ) : null}
        {/* Last Turn — the sidebar keeps its existing empty state; the popover
            only exposes the scope once a snapshot is available. */}
        {(!isPopover || hasLastTurnSnapshot) && (
          <button
            autoFocus={isPopover && hasLastTurnSnapshot && viewMode !== "agent-run"}
            onClick={selectLastTurn}
            className={`w-full px-3.5 py-2 text-left transition-colors border-b border-border ${
              viewMode === 'last-turn'
                ? "bg-primary/12"
                : "hover:bg-accent"
            }`}
          >
            <div className={`text-sm font-medium ${viewMode === 'last-turn' ? "text-foreground" : "text-muted-foreground"}`}>
              Last Turn
            </div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground/90 mt-0.5 font-mono">
              <span>{hasLastTurnSnapshot ? "Since last prompt" : "No turn recorded yet"}</span>
              {(lastTurnStats.additions > 0 || lastTurnStats.deletions > 0) && (
                <span className="ml-auto">
                  <span className="text-success">+{lastTurnStats.additions}</span>
                  {" "}
                  <span className="text-danger">-{lastTurnStats.deletions}</span>
                </span>
              )}
            </div>
          </button>
        )}

        {/* Uncommitted Changes */}
        <button
          autoFocus={isPopover && !hasLastTurnSnapshot && viewMode !== "agent-run"}
          onClick={selectUncommitted}
          className={`w-full px-3.5 py-2 text-left transition-colors border-b border-border ${
            viewMode === 'uncommitted'
              ? "bg-primary/12"
              : "hover:bg-accent"
          }`}
        >
          <div className={`text-sm font-medium ${viewMode === 'uncommitted' ? "text-foreground" : "text-muted-foreground"}`}>
            Uncommitted Changes
          </div>
          <div className="flex items-center gap-1 text-sm text-muted-foreground/90 mt-0.5 font-mono">
            <span>Working tree</span>
            {(uncommittedStats.additions > 0 || uncommittedStats.deletions > 0) && (
              <span className="ml-auto">
                <span className="text-success">+{uncommittedStats.additions}</span>
                {" "}
                <span className="text-danger">-{uncommittedStats.deletions}</span>
              </span>
            )}
          </div>
        </button>

        {/* All Changes */}
        <button
          onClick={selectAllChanges}
          className={`w-full px-3.5 py-2 text-left transition-colors border-b border-border ${
            viewMode === 'all-changes'
              ? "bg-primary/12"
              : "hover:bg-accent"
          }`}
        >
          <div className={`text-sm font-medium ${viewMode === 'all-changes' ? "text-foreground" : "text-muted-foreground"}`}>
            All Changes
          </div>
          <div className="flex items-center gap-1 text-sm text-muted-foreground/90 mt-0.5 font-mono">
            <span>vs {baseBranch || "base"}</span>
            {(allChangesStats.additions > 0 || allChangesStats.deletions > 0) && (
              <span className="ml-auto">
                <span className="text-success">+{allChangesStats.additions}</span>
                {" "}
                <span className="text-danger">-{allChangesStats.deletions}</span>
              </span>
            )}
          </div>
        </button>

        {/* Commits */}
        {commits.length === 0 ? (
          <div className="px-3.5 py-4 text-muted-foreground/90 text-sm">No commits ahead of {baseBranch}</div>
        ) : (
          commits.map((commit) => {
            const isSelected = viewMode === 'commit' && selectedCommit?.hash === commit.hash;
            return (
              <button
                key={commit.hash}
                onClick={() => selectCommit(commit)}
                className={`w-full px-3.5 py-2 text-left transition-colors border-b border-border/50 ${
                  isSelected
                    ? "bg-primary/12"
                    : "hover:bg-accent"
                }`}
              >
                <div className={`text-sm font-medium truncate ${isSelected ? "text-foreground" : "text-foreground/80"}`}>
                  {commit.message}
                </div>
                <div className="flex items-center gap-1 text-sm text-muted-foreground/90 mt-0.5 font-mono">
                  <span>{commit.hash.slice(0, 7)} &middot; {commit.date.split("T")[0]} {commit.date.split("T")[1]?.slice(0, 5)}</span>
                  {(commit.additions > 0 || commit.deletions > 0) && (
                    <span className="ml-auto">
                      <span className="text-success">+{commit.additions}</span>
                      {" "}
                      <span className="text-danger">-{commit.deletions}</span>
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
        </div>
      </div>

      {/* Changed Files — bottom half */}
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex items-center px-3.5 py-2 text-sm uppercase tracking-[1.2px] text-muted-foreground font-semibold shrink-0 border-y border-border">
          Changed Files
          {changedFiles.length > 0 && (
            <span className="ml-auto text-sm bg-accent rounded-full px-1.5 py-0.5 text-muted-foreground normal-case tracking-normal font-normal">{changedFiles.length}</span>
          )}
        </div>
        <div ref={filesScrollRef} className="overflow-y-auto flex-1 min-h-0">
          <div style={{ height: filesVirtualizer.getTotalSize(), position: "relative" }}>
          {filesVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = changedFileRows[virtualRow.index];
            const isDirectory = row.kind === "directory";
            const isCollapsed = isDirectory && collapsedDirectories.has(row.path);
            const file = row.kind === "file" ? row.file : null;
            const isSelected = file !== null && selectedFile?.path === file.path;
            const button = (
              <button
                type="button"
                onClick={(e) => {
                  if (row.kind === "directory") {
                    setCollapsedDirectories((current) => {
                      const next = new Set(current);
                      if (next.has(row.path)) next.delete(row.path);
                      else next.add(row.path);
                      return next;
                    });
                  } else if (e.metaKey && worktreePath) {
                    e.stopPropagation();
                    openFileInEditor(`${worktreePath}/${row.file.path}`);
                  } else {
                    selectFile(row.file);
                  }
                }}
                aria-expanded={isDirectory ? !isCollapsed : undefined}
                title={row.kind === "directory" ? row.path : row.file.path}
                className={`w-full pr-3.5 py-1.5 text-left font-mono text-sm flex items-center gap-1.5 transition-colors ${
                  isSelected ? "text-primary bg-primary/[0.06]" : "text-muted-foreground hover:bg-accent"
                }`}
                style={{
                  paddingLeft: `${0.875 + row.depth}rem`,
                  cursor: cmdHeld && file ? "pointer" : undefined,
                }}
              >
                {row.kind === "directory" ? (
                  <>
                    {isCollapsed ? (
                      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    {isCollapsed ? (
                      <Folder aria-hidden="true" className="size-3.5 shrink-0" />
                    ) : (
                      <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                  </>
                ) : (
                  <span className={`text-sm font-semibold w-3 text-center shrink-0 ${statusColor[row.file.status] || ""}`}>
                    {row.file.status}
                  </span>
                )}
                <span className="truncate">{row.name}</span>
              </button>
            );
            return (
              <div
                key={row.kind === "directory" ? `directory:${row.path}` : `file:${row.file.path}`}
                data-index={virtualRow.index}
                ref={filesVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {worktreePath && file ? (
                  <ChangedFileContextMenu
                    worktreePath={worktreePath}
                    filePath={file.path}
                    onRevealInFiles={onRevealInFiles}
                  >
                    {button}
                  </ChangedFileContextMenu>
                ) : (
                  button
                )}
              </div>
            );
          })}
          </div>
        </div>
      </div>
    </div>
  );
}
