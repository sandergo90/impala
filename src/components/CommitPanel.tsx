import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { ChangedFile } from "../types";

export function CommitPanel() {
  const {
    selectedWorktree, baseBranch, commits,
    selectedCommit, setSelectedCommit,
    changedFiles, setChangedFiles,
    selectedFile, setSelectedFile, setDiffText,
  } = useAppStore();

  if (!selectedWorktree) {
    return (
      <div className="flex items-center justify-center h-full w-64 min-w-64 border-r text-sm text-muted-foreground">
        Select a worktree
      </div>
    );
  }

  const selectCommit = async (commit: typeof commits[0]) => {
    setSelectedCommit(commit);
    try {
      const files = await invoke<ChangedFile[]>("get_changed_files", {
        worktreePath: selectedWorktree.path,
        commitHash: commit.hash,
      });
      setChangedFiles(files);
    } catch (e) {
      console.error("Failed to load changed files:", e);
    }
  };

  const selectFile = async (file: ChangedFile) => {
    setSelectedFile(file);
    if (!selectedCommit) return;
    try {
      const diff = await invoke<string>("get_commit_diff", {
        worktreePath: selectedWorktree.path,
        commitHash: selectedCommit.hash,
        filePath: file.path,
      });
      setDiffText(diff);
    } catch (e) {
      console.error("Failed to load diff:", e);
    }
  };

  const statusColor: Record<string, string> = {
    M: "text-green-500", A: "text-emerald-500", D: "text-red-500", R: "text-yellow-500",
  };

  return (
    <div className="flex flex-col h-full w-64 min-w-64 border-r text-sm">
      <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b">
        Commits on {selectedWorktree.branch}
      </div>
      {commits.length === 0 ? (
        <div className="px-3 py-4 text-muted-foreground text-xs">No commits ahead of {baseBranch}</div>
      ) : (
        <div className="overflow-y-auto">
          {commits.map((commit) => (
            <button key={commit.hash} onClick={() => selectCommit(commit)}
              className={`w-full px-3 py-2 text-left hover:bg-accent/10 ${
                selectedCommit?.hash === commit.hash ? "bg-accent/10 border-l-2 border-primary" : ""
              }`}>
              <div className="font-medium text-xs truncate">{commit.message}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {commit.hash.slice(0, 7)} · {commit.date.split("T")[0]}
              </div>
            </button>
          ))}
        </div>
      )}
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
