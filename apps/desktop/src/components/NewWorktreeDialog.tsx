import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { useInvoke } from "../hooks/useInvoke";
import type { BranchInfo, Worktree, Issue, IssueTrackerInfo } from "../types";
import type { Agent } from "../lib/agent";

interface NewWorktreeDialogProps {
  repoPath: string;
  onCreated: (worktree: Worktree) => void;
  onCancel: () => void;
}

type Tab = "new" | "existing" | "tracker";

const TRACKER_LABELS: Record<string, string> = {
  linear: "Linear",
  jira: "Jira",
};

export function NewWorktreeDialog({
  repoPath,
  onCreated,
  onCancel,
}: NewWorktreeDialogProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("new");
  const [branchName, setBranchName] = useState("");
  const [projectBaseBranch, setProjectBaseBranch] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [loading, setLoading] = useState(false);

  const [trackerInfo, setTrackerInfo] = useState<IssueTrackerInfo | null>(null);
  const [searchResults, setSearchResults] = useState<Issue[]>([]);
  const [issueQuery, setIssueQuery] = useState("");
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [issueBranchName, setIssueBranchName] = useState("");
  const [comboboxOpen, setComboboxOpen] = useState(false);
  const [branchPrefix, setBranchPrefix] = useState("");
  const [existingQuery, setExistingQuery] = useState("");
  const [existingComboboxOpen, setExistingComboboxOpen] = useState(false);
  const [agent, setAgent] = useState<Agent>("claude");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const comboboxRef = useRef<HTMLDivElement>(null);
  const existingComboboxRef = useRef<HTMLDivElement>(null);

  const tracker = trackerInfo?.tracker ?? "none";
  const trackerLabel = TRACKER_LABELS[tracker] ?? "Issues";

  useEffect(() => {
    invoke<string | null>("get_setting", {
      key: "lastAgentForProject",
      scope: repoPath,
    }).then((v) => {
      if (v === "codex") setAgent("codex");
    });
  }, [repoPath]);

  // The Project's chosen Issue tracker decides whether (and which) tracker tab
  // shows. Not gated on credentials — `configured` drives the in-tab hint.
  useEffect(() => {
    invoke<IssueTrackerInfo>("get_project_issue_tracker", { projectPath: repoPath })
      .then(setTrackerInfo)
      .catch(() => setTrackerInfo({ tracker: "none", configured: false }));
  }, [repoPath]);

  // Base branch is a per-project setting (configured on the project settings
  // page), no longer chosen per-creation. Empty/unset → backend forks from HEAD.
  useEffect(() => {
    invoke<string | null>("get_setting", {
      key: "baseBranch",
      scope: repoPath,
    }).then((v) => setProjectBaseBranch(v?.trim() || null));
  }, [repoPath]);

  useEffect(() => {
    async function resolvePrefix() {
      const mode = await invoke<string | null>("get_setting", { key: "branchPrefixMode", scope: "global" });
      if (!mode || mode === "none") return;
      if (mode === "custom") {
        const custom = await invoke<string | null>("get_setting", { key: "branchPrefixCustom", scope: "global" });
        if (custom) setBranchPrefix(custom + "/");
      } else if (mode === "author") {
        const info = await invoke<{ author_name: string | null }>("get_git_info");
        if (info.author_name) {
          const sanitized = info.author_name.toLowerCase().replace(/[^a-z0-9-]/g, "");
          if (sanitized) setBranchPrefix(sanitized + "/");
        }
      }
    }
    resolvePrefix();
  }, []);

  const { data: branches, refetch: refetchBranches } = useInvoke<BranchInfo[]>(
    "list_branches",
    { repoPath },
    { onError: () => toast.error("Failed to load branches") },
  );
  const [fetchingRemote, setFetchingRemote] = useState(false);
  const fetchedRef = useRef(false);

  // On first visit to the Existing tab, fetch origin in the background so the
  // branch list reflects what's actually on the remote. The local list shows
  // immediately; we refresh it once the fetch completes.
  useEffect(() => {
    if (tab !== "existing" || fetchedRef.current) return;
    fetchedRef.current = true;
    setFetchingRemote(true);
    invoke("fetch_remote", { repoPath })
      .then(() => refetchBranches())
      .catch(() => toast.error("Failed to fetch remote"))
      .finally(() => setFetchingRemote(false));
  }, [tab, repoPath, refetchBranches]);

  const filteredBranches = (branches ?? []).filter((b) =>
    b.name.toLowerCase().includes(existingQuery.toLowerCase()),
  );

  const { data: myIssues, loading: issuesLoading } = useInvoke<Issue[]>(
    "list_my_issues",
    { projectPath: repoPath },
    {
      enabled: tab === "tracker" && !!trackerInfo?.configured,
      onError: (e) => toast.error(`Failed to load ${trackerLabel} issues: ${e}`),
    },
  );

  const handleIssueSearch = useCallback((query: string) => {
    setIssueQuery(query);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await invoke<Issue[]>("search_issues", {
          projectPath: repoPath,
          query: query.trim(),
        });
        setSearchResults(results);
      } catch (e) {
        console.error("Issue search failed:", e);
      }
    }, 300);
  }, [repoPath]);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Close comboboxes on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (comboboxRef.current && !comboboxRef.current.contains(e.target as Node)) {
        setComboboxOpen(false);
      }
      if (
        existingComboboxRef.current &&
        !existingComboboxRef.current.contains(e.target as Node)
      ) {
        setExistingComboboxOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const selectIssue = (issue: Issue) => {
    setSelectedIssue(issue);
    const name =
      branchPrefix && issue.branch_name.startsWith(branchPrefix)
        ? issue.branch_name.slice(branchPrefix.length)
        : issue.branch_name;
    setIssueBranchName(name);
    setComboboxOpen(false);
    setIssueQuery("");
  };

  const displayedIssues = issueQuery.trim() ? searchResults : (myIssues ?? []);

  const tabs: { id: Tab; label: string }[] = [
    { id: "new", label: "New branch" },
    { id: "existing", label: "Existing branch" },
    ...(tracker !== "none" ? [{ id: "tracker" as Tab, label: trackerLabel }] : []),
  ];

  const handleCreate = async () => {
    let name: string;
    let base: string | null;
    let existing = false;

    if (tab === "tracker") {
      if (!selectedIssue) {
        toast.error(`Please select a ${trackerLabel} issue`);
        return;
      }
      if (!issueBranchName.trim()) {
        toast.error("Please specify a branch name");
        return;
      }
      name = issueBranchName.trim();
      base = projectBaseBranch;
    } else if (tab === "existing") {
      if (!selectedBranch) {
        toast.error("Please select a branch from the list");
        return;
      }
      name = selectedBranch;
      base = null;
      existing = true;
    } else {
      if (!branchName.trim()) {
        toast.error("Please specify a branch name");
        return;
      }
      name = branchName.trim();
      base = projectBaseBranch;
    }

    setLoading(true);
    try {
      const worktree = await invoke<Worktree>("create_worktree", {
        repoPath,
        branchName: name,
        baseBranch: base,
        existing,
        initialTitle: tab === "tracker" && selectedIssue ? selectedIssue.title : null,
        agent,
      });
      // Best-effort: link to the issue, move it to In Progress, and write its
      // context file (fire-and-forget). The backend resolves the project's
      // tracker, so this works for Linear and Jira alike.
      if (tab === "tracker" && selectedIssue) {
        invoke("link_worktree_issue", {
          worktreePath: worktree.path,
          issueId: selectedIssue.id,
          identifier: selectedIssue.identifier,
          provider: tracker,
          url: selectedIssue.url,
        }).catch(() => {});
        invoke("start_issue", {
          projectPath: repoPath,
          issueId: selectedIssue.id,
        }).catch(() => {});
        invoke("write_issue_context", {
          projectPath: repoPath,
          issueId: selectedIssue.id,
          worktreePath: worktree.path,
          force: true,
        }).catch(() => {});
      }
      onCreated(worktree);
    } catch (e) {
      toast.error(`Failed to create worktree: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-worktree-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <form
        className="bg-popover border rounded-lg shadow-lg p-6 w-[420px] space-y-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
      >
        <h2 id="new-worktree-title" className="text-lg font-semibold">
          New Worktree
        </h2>

        <div className="flex gap-2">
          {(["claude", "codex"] as const).map((a) => (
            <button
              type="button"
              key={a}
              onClick={() => setAgent(a)}
              className={`flex-1 px-3 py-1.5 rounded border text-sm ${
                agent === a
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {a === "claude" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>

        <div className="flex border-b border-border">
          {tabs.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-sm transition-colors relative ${
                tab === t.id
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {tab === t.id && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary" />
              )}
            </button>
          ))}
        </div>

        {tab === "new" && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-muted-foreground mb-1">
                Branch name
              </label>
              <div className="flex w-full border rounded bg-popover overflow-hidden">
                {branchPrefix && (
                  <span className="px-3 py-1.5 text-sm text-muted-foreground bg-muted/50 shrink-0 border-r">
                    {branchPrefix}
                  </span>
                )}
                <input
                  type="text"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  placeholder="feature/my-branch"
                  className="flex-1 px-3 py-1.5 text-sm bg-transparent outline-none"
                  autoFocus
                  spellCheck={false}
                />
              </div>
            </div>
          </div>
        )}

        {tab === "existing" && (
          <div>
            <label className="block text-sm text-muted-foreground mb-1">
              Branch
            </label>
            <div className="relative" ref={existingComboboxRef}>
              {selectedBranch ? (
                <div className="flex items-center gap-2 w-full px-3 py-1.5 border rounded text-sm bg-popover">
                  <span className="font-mono truncate flex-1">{selectedBranch}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedBranch("")}
                    className="text-muted-foreground hover:text-foreground text-sm shrink-0"
                  >
                    &times;
                  </button>
                </div>
              ) : (
                <input
                  type="text"
                  value={existingQuery}
                  onChange={(e) => setExistingQuery(e.target.value)}
                  onFocus={() => setExistingComboboxOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && existingComboboxOpen) {
                      e.preventDefault();
                      if (filteredBranches.length > 0) {
                        setSelectedBranch(filteredBranches[0].name);
                        setExistingComboboxOpen(false);
                        setExistingQuery("");
                      }
                    }
                  }}
                  placeholder={
                    fetchingRemote
                      ? "Fetching origin..."
                      : branches
                        ? "Search branches..."
                        : "Loading branches..."
                  }
                  className="w-full px-3 py-1.5 border rounded text-sm bg-popover"
                  autoFocus
                  spellCheck={false}
                />
              )}
              {existingComboboxOpen && !selectedBranch && (
                <div className="absolute z-10 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto border rounded bg-popover shadow-lg">
                  {filteredBranches.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      {branches ? "No matching branches" : "Loading..."}
                    </div>
                  ) : (
                    filteredBranches.map((b) => (
                      <button
                        type="button"
                        key={b.name}
                        onClick={() => {
                          setSelectedBranch(b.name);
                          setExistingComboboxOpen(false);
                          setExistingQuery("");
                        }}
                        className="w-full px-3 py-1.5 text-left hover:bg-accent flex items-center gap-2"
                      >
                        <span className="font-mono text-sm truncate flex-1">{b.name}</span>
                        {b.is_remote && (
                          <span className="text-xs text-muted-foreground shrink-0 px-1.5 py-0.5 rounded bg-accent">
                            remote
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "tracker" && (
          <div className="space-y-3">
            {!trackerInfo?.configured ? (
              <div className="p-4 rounded border border-border bg-card text-center space-y-2">
                {tracker === "jira" ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Configure this project's Jira connection to use this feature.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        onCancel();
                        navigate({
                          to: "/settings/project/$projectId",
                          params: { projectId: encodeURIComponent(repoPath) },
                        });
                      }}
                      className="text-sm text-[var(--color-link)] hover:underline"
                    >
                      Open Project Settings
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Add your Linear API key in Settings to use this feature.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        onCancel();
                        navigate({ to: "/settings" });
                      }}
                      className="text-sm text-[var(--color-link)] hover:underline"
                    >
                      Open Settings
                    </button>
                  </>
                )}
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    Issue
                  </label>
                  <div className="relative" ref={comboboxRef}>
                    {selectedIssue ? (
                      <div className="flex items-center gap-2 w-full px-3 py-1.5 border rounded text-sm bg-popover">
                        <span className="font-mono text-sm text-muted-foreground">
                          {selectedIssue.identifier}
                        </span>
                        <span className="truncate flex-1">{selectedIssue.title}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedIssue(null);
                            setIssueBranchName("");
                          }}
                          className="text-muted-foreground hover:text-foreground text-sm shrink-0"
                        >
                          &times;
                        </button>
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={issueQuery}
                        onChange={(e) => handleIssueSearch(e.target.value)}
                        onFocus={() => setComboboxOpen(true)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && comboboxOpen) {
                            e.preventDefault();
                          }
                        }}
                        placeholder={issuesLoading ? "Loading issues..." : "Search issues..."}
                        className="w-full px-3 py-1.5 border rounded text-sm bg-popover"
                        autoFocus
                        spellCheck={false}
                      />
                    )}
                    {comboboxOpen && !selectedIssue && (
                      <div className="absolute z-10 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto border rounded bg-popover shadow-lg">
                        {displayedIssues.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-muted-foreground">
                            {issuesLoading ? "Loading..." : issueQuery ? "No results" : "No issues found"}
                          </div>
                        ) : (
                          displayedIssues.map((issue) => (
                            <button
                              type="button"
                              key={issue.id}
                              onClick={() => selectIssue(issue)}
                              className="w-full px-3 py-1.5 text-left hover:bg-accent flex items-center gap-2"
                            >
                              <span className="font-mono text-sm text-muted-foreground shrink-0">
                                {issue.identifier}
                              </span>
                              <span className="text-sm truncate flex-1">{issue.title}</span>
                              <span className="text-xs text-muted-foreground shrink-0 px-1.5 py-0.5 rounded bg-accent">
                                {issue.status}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-muted-foreground mb-1">
                    Branch name
                  </label>
                  <div className="flex w-full border rounded bg-popover overflow-hidden">
                    {branchPrefix && (
                      <span className="px-3 py-1.5 text-sm text-muted-foreground bg-muted/50 shrink-0 border-r">
                        {branchPrefix}
                      </span>
                    )}
                    <input
                      type="text"
                      value={issueBranchName}
                      onChange={(e) => setIssueBranchName(e.target.value)}
                      placeholder="Select an issue to auto-fill"
                      className="flex-1 px-3 py-1.5 text-sm bg-transparent outline-none"
                      spellCheck={false}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm border rounded hover:bg-accent/10"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || (tab === "tracker" && !trackerInfo?.configured)}
            className="px-3 py-1.5 text-sm border rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
