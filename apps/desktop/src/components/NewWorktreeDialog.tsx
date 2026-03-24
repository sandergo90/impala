import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { BranchInfo, Worktree } from "../types";

interface NewWorktreeDialogProps {
  repoPath: string;
  onCreated: (worktree: Worktree) => void;
  onCancel: () => void;
}

export function NewWorktreeDialog({
  repoPath,
  onCreated,
  onCancel,
}: NewWorktreeDialogProps) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);

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

  const handleCreate = async () => {
    const name = mode === "new" ? branchName.trim() : selectedBranch;
    if (!name) {
      toast.error("Please specify a branch name");
      return;
    }

    setLoading(true);
    try {
      const worktree = await invoke<Worktree>("create_worktree", {
        repoPath,
        branchName: name,
        baseBranch: mode === "new" && baseBranch.trim() ? baseBranch.trim() : null,
        existing: mode === "existing",
      });
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
    >
      <div
        className="bg-background border rounded-lg shadow-lg p-6 w-96 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">New Worktree</h2>

        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-sm cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={mode === "new"}
              onChange={() => setMode("new")}
            />
            New branch
          </label>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={mode === "existing"}
              onChange={() => setMode("existing")}
            />
            Existing branch
          </label>
        </div>

        {mode === "new" ? (
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
        ) : (
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

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm border rounded hover:bg-accent/10"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={loading}
            className="px-3 py-1.5 text-sm border rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
