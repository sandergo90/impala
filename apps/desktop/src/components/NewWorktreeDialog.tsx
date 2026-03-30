import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore } from "../store";
import type { BranchInfo, Worktree, LinearIssue } from "../types";

interface NewWorktreeDialogProps {
  repoPath: string;
  onCreated: (worktree: Worktree) => void;
  onCancel: () => void;
}

type Tab = "new" | "existing" | "linear";

export function NewWorktreeDialog({
  repoPath,
  onCreated,
  onCancel,
}: NewWorktreeDialogProps) {
  const [tab, setTab] = useState<Tab>("new");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);

  // Linear state
  const linearApiKey = useUIStore((s) => s.linearApiKey);
  const [myIssues, setMyIssues] = useState<LinearIssue[]>([]);
  const [searchResults, setSearchResults] = useState<LinearIssue[]>([]);
  const [linearQuery, setLinearQuery] = useState("");
  const [linearLoading, setLinearLoading] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<LinearIssue | null>(null);
  const [linearBranchName, setLinearBranchName] = useState("");
  const [linearBaseBranch, setLinearBaseBranch] = useState("");
  const [comboboxOpen, setComboboxOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const comboboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await invoke<BranchInfo[]>("list_branches", { repoPath });
        setBranches(result);
        if (result.length > 0) {
          setSelectedBranch(result[0].name);
        }
      } catch (e) {
        toast.error("Failed to load branches");
      }
    })();
  }, [repoPath]);

  // Fetch my issues when Linear tab is selected
  useEffect(() => {
    if (tab !== "linear" || !linearApiKey) return;
    (async () => {
      setLinearLoading(true);
      try {
        const issues = await invoke<LinearIssue[]>("get_my_linear_issues", { apiKey: linearApiKey });
        setMyIssues(issues);
      } catch (e) {
        toast.error(`Failed to load Linear issues: ${e}`);
      } finally {
        setLinearLoading(false);
      }
    })();
  }, [tab, linearApiKey]);

  // Debounced search
  const handleLinearSearch = useCallback((query: string) => {
    setLinearQuery(query);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await invoke<LinearIssue[]>("search_linear_issues", {
          apiKey: linearApiKey,
          query: query.trim(),
        });
        setSearchResults(results);
      } catch (e) {
        // Silently fail search — user can retry
      }
    }, 300);
  }, [linearApiKey]);

  // Close combobox on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (comboboxRef.current && !comboboxRef.current.contains(e.target as Node)) {
        setComboboxOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const selectIssue = (issue: LinearIssue) => {
    setSelectedIssue(issue);
    setLinearBranchName(issue.branch_name);
    setComboboxOpen(false);
    setLinearQuery("");
  };

  const displayedIssues = linearQuery.trim() ? searchResults : myIssues;

  const handleCreate = async () => {
    if (tab === "linear") {
      if (!selectedIssue) {
        toast.error("Please select a Linear issue");
        return;
      }
      if (!linearBranchName.trim()) {
        toast.error("Please specify a branch name");
        return;
      }
      setLoading(true);
      try {
        const worktree = await invoke<Worktree>("create_worktree", {
          repoPath,
          branchName: linearBranchName.trim(),
          baseBranch: linearBaseBranch.trim() || null,
          existing: false,
        });
        // Link worktree to issue and move to In Progress (best-effort, don't block)
        await Promise.all([
          invoke("link_worktree_issue", {
            worktreePath: worktree.path,
            issueId: selectedIssue.id,
            identifier: selectedIssue.identifier,
          }).catch(() => {}),
          invoke("start_linear_issue", {
            apiKey: linearApiKey,
            issueId: selectedIssue.id,
          }).catch(() => {}),
        ]);
        onCreated(worktree);
      } catch (e) {
        toast.error(`Failed to create worktree: ${e}`);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Existing "new" and "existing" tab logic
    const name = tab === "new" ? branchName.trim() : selectedBranch;
    if (!name) {
      toast.error("Please specify a branch name");
      return;
    }
    setLoading(true);
    try {
      const worktree = await invoke<Worktree>("create_worktree", {
        repoPath,
        branchName: name,
        baseBranch: tab === "new" && baseBranch.trim() ? baseBranch.trim() : null,
        existing: tab === "existing",
      });
      onCreated(worktree);
    } catch (e) {
      toast.error(`Failed to create worktree: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "new", label: "New branch" },
    { id: "existing", label: "Existing branch" },
    { id: "linear", label: "Linear" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="bg-background border rounded-lg shadow-lg p-6 w-[420px] space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">New Worktree</h2>

        {/* Tabs */}
        <div className="flex border-b border-border">
          {tabs.map((t) => (
            <button
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

        {/* New branch tab */}
        {tab === "new" && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                Branch name
              </label>
              <input
                type="text"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="feature/my-branch"
                className="w-full px-3 py-1.5 border rounded text-sm bg-background"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                Base branch (optional, defaults to HEAD)
              </label>
              <input
                type="text"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="main"
                className="w-full px-3 py-1.5 border rounded text-sm bg-background"
              />
            </div>
          </div>
        )}

        {/* Existing branch tab */}
        {tab === "existing" && (
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              Branch
            </label>
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              className="w-full px-3 py-1.5 border rounded text-sm bg-background"
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.is_remote ? " (remote)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Linear tab */}
        {tab === "linear" && (
          <div className="space-y-3">
            {!linearApiKey ? (
              <div className="p-4 rounded border border-border bg-card text-center space-y-2">
                <p className="text-sm text-muted-foreground">
                  Add your Linear API key in Settings to use this feature.
                </p>
                <button
                  onClick={() => {
                    onCancel();
                    useUIStore.getState().setCurrentView("settings");
                  }}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Open Settings
                </button>
              </div>
            ) : (
              <>
                {/* Issue combobox */}
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Issue
                  </label>
                  <div className="relative" ref={comboboxRef}>
                    {selectedIssue ? (
                      <div className="flex items-center gap-2 w-full px-3 py-1.5 border rounded text-sm bg-background">
                        <span className="font-mono text-xs text-muted-foreground">
                          {selectedIssue.identifier}
                        </span>
                        <span className="truncate flex-1">{selectedIssue.title}</span>
                        <button
                          onClick={() => {
                            setSelectedIssue(null);
                            setLinearBranchName("");
                          }}
                          className="text-muted-foreground hover:text-foreground text-xs shrink-0"
                        >
                          &times;
                        </button>
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={linearQuery}
                        onChange={(e) => handleLinearSearch(e.target.value)}
                        onFocus={() => setComboboxOpen(true)}
                        placeholder={linearLoading ? "Loading issues..." : "Search issues..."}
                        className="w-full px-3 py-1.5 border rounded text-sm bg-background"
                        autoFocus
                      />
                    )}
                    {comboboxOpen && !selectedIssue && (
                      <div className="absolute z-10 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto border rounded bg-popover shadow-lg">
                        {displayedIssues.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-muted-foreground">
                            {linearLoading ? "Loading..." : linearQuery ? "No results" : "No issues found"}
                          </div>
                        ) : (
                          displayedIssues.map((issue) => (
                            <button
                              key={issue.id}
                              onClick={() => selectIssue(issue)}
                              className="w-full px-3 py-1.5 text-left hover:bg-accent flex items-center gap-2"
                            >
                              <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                                {issue.identifier}
                              </span>
                              <span className="text-xs truncate flex-1">{issue.title}</span>
                              <span className="text-[10px] text-muted-foreground shrink-0 px-1.5 py-0.5 rounded bg-accent">
                                {issue.status}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Branch name (auto-filled from issue) */}
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Branch name
                  </label>
                  <input
                    type="text"
                    value={linearBranchName}
                    onChange={(e) => setLinearBranchName(e.target.value)}
                    placeholder="Select an issue to auto-fill"
                    className="w-full px-3 py-1.5 border rounded text-sm bg-background"
                  />
                </div>

                {/* Base branch */}
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Base branch (optional, defaults to HEAD)
                  </label>
                  <input
                    type="text"
                    value={linearBaseBranch}
                    onChange={(e) => setLinearBaseBranch(e.target.value)}
                    placeholder="main"
                    className="w-full px-3 py-1.5 border rounded text-sm bg-background"
                  />
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm border rounded hover:bg-accent/10"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={loading || (tab === "linear" && !linearApiKey)}
            className="px-3 py-1.5 text-sm border rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
