import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useAppStore } from "../store";
import type { ChangedFile, CommitInfo } from "../types";

const statusColor: Record<string, string> = {
  M: "text-green-500", A: "text-emerald-500", D: "text-red-500", R: "text-yellow-500",
};

export function CommitPanel() {
  const {
    selectedWorktree, baseBranch, commits,
    selectedCommit, setSelectedCommit,
    changedFiles, setChangedFiles,
    selectedFile, setSelectedFile, setDiffText,
    viewMode, setViewMode,
  } = useAppStore();

  if (!selectedWorktree) {
    return (
      <div className="flex items-center justify-center h-full border-r text-sm text-muted-foreground">
        Select a worktree
      </div>
    );
  }

  const selectAllChanges = async () => {
    setViewMode('all-changes');
    setSelectedCommit(null);
    setChangedFiles([]);
    setSelectedFile(null);
    setDiffText(null);
    try {
      const files = await invoke<ChangedFile[]>("get_all_changed_files", {
        worktreePath: selectedWorktree.path,
      });
      setChangedFiles(files);
    } catch (e) {
      toast.error("Failed to load changed files");
    }
  };

  const selectCommit = async (commit: CommitInfo) => {
    setViewMode('commit');
    setSelectedCommit(commit);
    setChangedFiles([]);
    try {
      const files = await invoke<ChangedFile[]>("get_changed_files", {
        worktreePath: selectedWorktree.path,
        commitHash: commit.hash,
      });
      setChangedFiles(files);
    } catch (e) {
      toast.error("Failed to load changed files");
    }
  };

  const selectFile = async (file: ChangedFile) => {
    setSelectedFile(file);
    try {
      let diff: string;
      if (viewMode === 'all-changes') {
        diff = await invoke<string>("get_branch_diff", {
          worktreePath: selectedWorktree.path,
          filePath: file.path,
        });
      } else {
        if (!selectedCommit) return;
        diff = await invoke<string>("get_commit_diff", {
          worktreePath: selectedWorktree.path,
          commitHash: selectedCommit.hash,
          filePath: file.path,
        });
      }
      setDiffText(diff);
    } catch (e) {
      toast.error("Failed to load diff");
    }
  };

  return (
    <div className="flex flex-col h-full border-r text-sm">
      <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b">
        Commits on {selectedWorktree.branch}
      </div>
      <div className="overflow-y-auto">
        <button
          onClick={selectAllChanges}
          className={`w-full px-3 py-2 text-left hover:bg-accent/10 ${
            viewMode === 'all-changes' ? "bg-accent/10 border-l-2 border-primary" : ""
          }`}
        >
          <div className="font-medium text-xs">All Changes</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            vs {baseBranch || "base"}
          </div>
        </button>
        {commits.length === 0 ? (
          <div className="px-3 py-4 text-muted-foreground text-xs">No commits ahead of {baseBranch}</div>
        ) : (
          commits.map((commit) => (
            <button key={commit.hash} onClick={() => selectCommit(commit)}
              className={`w-full px-3 py-2 text-left hover:bg-accent/10 ${
                viewMode === 'commit' && selectedCommit?.hash === commit.hash ? "bg-accent/10 border-l-2 border-primary" : ""
              }`}>
              <div className="font-medium text-xs truncate">{commit.message}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {commit.hash.slice(0, 7)} · {commit.date.split("T")[0]}
              </div>
            </button>
          ))
        )}
      </div>
      {changedFiles.length > 0 && (
        <>
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-t border-b">Changed Files</div>
          <div className="overflow-y-auto">
            {changedFiles.map((file) => (
              <button key={file.path} onClick={() => selectFile(file)}
                className={`w-full px-3 py-1.5 text-left font-mono text-xs hover:bg-accent/10 ${
                  selectedFile?.path === file.path ? "bg-accent/10 text-primary" : "text-muted-foreground"
                }`}>
                <span className={`mr-1.5 ${statusColor[file.status] || ""}`}>{file.status}</span>
                {file.path.split("/").pop()}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
