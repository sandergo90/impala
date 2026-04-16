import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { useUIStore } from "../store";
import { useInvoke } from "../hooks/useInvoke";
import type { BranchInfo, Worktree, LinearIssue } from "../types";

interface NewWorktreeDialogProps {
  repoPath: string;
  onCreated: (worktree: Worktree) => void;
  onCancel: () => void;
}

type Tab = "new" | "existing" | "linear";

const tabs: { id: Tab; label: string }[] = [
  { id: "new", label: "New branch" },
  { id: "existing", label: "Existing branch" },
  { id: "linear", label: "Linear" },
];

export function NewWorktreeDialog({
  repoPath,
  onCreated,
  onCancel,
}: NewWorktreeDialogProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("new");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("develop");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [loading, setLoading] = useState(false);

  const linearApiKey = useUIStore((s) => s.linearApiKey);
  const [searchResults, setSearchResults] = useState<LinearIssue[]>([]);
  const [linearQuery, setLinearQuery] = useState("");
  const [selectedIssue, setSelectedIssue] = useState<LinearIssue | null>(null);
  const [linearBranchName, setLinearBranchName] = useState("");
  const [linearBaseBranch, setLinearBaseBranch] = useState("develop");
  const [comboboxOpen, setComboboxOpen] = useState(false);
  const [branchPrefix, setBranchPrefix] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const comboboxRef = useRef<HTMLDivElement>(null);

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

  const { data: branches } = useInvoke<BranchInfo[]>("list_branches", { repoPath }, {
    onSuccess: (result) => {
      if (result.length > 0) setSelectedBranch(result[0].name);
    },
    onError: () => toast.error("Failed to load branches"),
  });

  const { data: myIssues, loading: linearLoading } = useInvoke<LinearIssue[]>(
    "get_my_linear_issues",
    { apiKey: linearApiKey },
    {
      enabled: tab === "linear" && !!linearApiKey,
      onError: (e) => toast.error(`Failed to load Linear issues: ${e}`),
    },
  );

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
        console.error("Linear search failed:", e);
      }
    }, 300);
  }, [linearApiKey]);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

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

  const displayedIssues = linearQuery.trim() ? searchResults : (myIssues ?? []);

  const handleCreate = async () => {
    let name: string;
    let base: string | null;
    let existing = false;

    if (tab === "linear") {
      if (!selectedIssue) {
        toast.error("Please select a Linear issue");
        return;
      }
      if (!linearBranchName.trim()) {
        toast.error("Please specify a branch name");
        return;
      }
      name = linearBranchName.trim();
      base = linearBaseBranch.trim() || null;
    } else if (tab === "existing") {
      if (!selectedBranch) {
        toast.error("Please specify a branch name");
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
      base = baseBranch.trim() || null;
    }

    setLoading(true);
    try {
      const worktree = await invoke<Worktree>("create_worktree", {
        repoPath,
        branchName: name,
        baseBranch: base,
        existing,
        initialTitle: tab === "linear" && selectedIssue ? selectedIssue.title : null,
      });
      // Best-effort: link to Linear issue and move to In Progress (fire-and-forget)
      if (tab === "linear" && selectedIssue) {
        invoke("link_worktree_issue", {
          worktreePath: worktree.path,
          issueId: selectedIssue.id,
          identifier: selectedIssue.identifier,
        }).catch(() => {});
        invoke("start_linear_issue", {
          apiKey: linearApiKey,
          issueId: selectedIssue.id,
        }).catch(() => {});
        invoke("write_linear_context", {
          apiKey: linearApiKey,
          issueId: selectedIssue.id,
          worktreePath: worktree.path,
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
        className="bg-background border rounded-lg shadow-lg p-6 w-[420px] space-y-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
      >
        <h2 className="text-lg font-semibold">New Worktree</h2>

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
              <label className="block text-md text-muted-foreground mb-1">
                Branch name
              </label>
              <div className="flex w-full border rounded bg-background overflow-hidden">
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
            <div>
              <label className="block text-md text-muted-foreground mb-1">
                Base branch (optional, defaults to HEAD)
              </label>
              <input
                type="text"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="develop"
                className="w-full px-3 py-1.5 border rounded text-sm bg-background"
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {tab === "existing" && (
          <div>
            <label className="block text-md text-muted-foreground mb-1">
              Branch
            </label>
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              className="w-full px-3 py-1.5 border rounded text-sm bg-background"
            >
              {(branches ?? []).map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.is_remote ? " (remote)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {tab === "linear" && (
          <div className="space-y-3">
            {!linearApiKey ? (
              <div className="p-4 rounded border border-border bg-card text-center space-y-2">
                <p className="text-sm text-muted-foreground">
                  Add your Linear API key in Settings to use this feature.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onCancel();
                    navigate({ to: "/settings" });
                  }}
                  className="text-md text-blue-400 hover:text-blue-300"
                >
                  Open Settings
                </button>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-md text-muted-foreground mb-1">
                    Issue
                  </label>
                  <div className="relative" ref={comboboxRef}>
                    {selectedIssue ? (
                      <div className="flex items-center gap-2 w-full px-3 py-1.5 border rounded text-sm bg-background">
                        <span className="font-mono text-md text-muted-foreground">
                          {selectedIssue.identifier}
                        </span>
                        <span className="truncate flex-1">{selectedIssue.title}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedIssue(null);
                            setLinearBranchName("");
                          }}
                          className="text-muted-foreground hover:text-foreground text-md shrink-0"
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
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && comboboxOpen) {
                            e.preventDefault();
                          }
                        }}
                        placeholder={linearLoading ? "Loading issues..." : "Search issues..."}
                        className="w-full px-3 py-1.5 border rounded text-sm bg-background"
                        autoFocus
                        spellCheck={false}
                      />
                    )}
                    {comboboxOpen && !selectedIssue && (
                      <div className="absolute z-10 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto border rounded bg-popover shadow-lg">
                        {displayedIssues.length === 0 ? (
                          <div className="px-3 py-2 text-md text-muted-foreground">
                            {linearLoading ? "Loading..." : linearQuery ? "No results" : "No issues found"}
                          </div>
                        ) : (
                          displayedIssues.map((issue) => (
                            <button
                              type="button"
                              key={issue.id}
                              onClick={() => selectIssue(issue)}
                              className="w-full px-3 py-1.5 text-left hover:bg-accent flex items-center gap-2"
                            >
                              <span className="font-mono text-md text-muted-foreground shrink-0">
                                {issue.identifier}
                              </span>
                              <span className="text-md truncate flex-1">{issue.title}</span>
                              <span className="text-md text-muted-foreground shrink-0 px-1.5 py-0.5 rounded bg-accent">
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
                  <label className="block text-md text-muted-foreground mb-1">
                    Branch name
                  </label>
                  <div className="flex w-full border rounded bg-background overflow-hidden">
                    {branchPrefix && (
                      <span className="px-3 py-1.5 text-sm text-muted-foreground bg-muted/50 shrink-0 border-r">
                        {branchPrefix}
                      </span>
                    )}
                    <input
                      type="text"
                      value={linearBranchName}
                      onChange={(e) => setLinearBranchName(e.target.value)}
                      placeholder="Select an issue to auto-fill"
                      className="flex-1 px-3 py-1.5 text-sm bg-transparent outline-none"
                      spellCheck={false}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-md text-muted-foreground mb-1">
                    Base branch (optional, defaults to HEAD)
                  </label>
                  <input
                    type="text"
                    value={linearBaseBranch}
                    onChange={(e) => setLinearBaseBranch(e.target.value)}
                    placeholder="develop"
                    className="w-full px-3 py-1.5 border rounded text-sm bg-background"
                    spellCheck={false}
                  />
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
            disabled={loading || (tab === "linear" && !linearApiKey)}
            className="px-3 py-1.5 text-sm border rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
