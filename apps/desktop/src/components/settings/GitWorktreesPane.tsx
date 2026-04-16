import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface GitInfo {
  author_name: string | null;
}

type BranchPrefixMode = "none" | "author" | "custom";

const BRANCH_PREFIX_LABELS: Record<BranchPrefixMode, string> = {
  none: "No prefix",
  author: "Git author name",
  custom: "Custom prefix",
};

function sanitizePrefix(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

function resolvePreviewPrefix(
  mode: BranchPrefixMode,
  customPrefix: string,
  gitInfo: GitInfo | null,
): string {
  switch (mode) {
    case "author":
      return gitInfo?.author_name
        ? sanitizePrefix(gitInfo.author_name)
        : "author-name";
    case "custom":
      return customPrefix || "prefix";
    default:
      return "";
  }
}

export function GitWorktreesPane() {
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [prefixMode, setPrefixMode] = useState<BranchPrefixMode>("none");
  const [customPrefix, setCustomPrefix] = useState("");
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [worktreeBaseDir, setWorktreeBaseDir] = useState<string | null>(null);
  const [defaultBaseDir, setDefaultBaseDir] = useState("");

  useEffect(() => {
    invoke<string | null>("get_setting", {
      key: "deleteLocalBranch",
      scope: "global",
    }).then((v) => setDeleteBranch(v !== "false"));

    invoke<string | null>("get_setting", {
      key: "branchPrefixMode",
      scope: "global",
    }).then((v) => {
      if (v) setPrefixMode(v as BranchPrefixMode);
    });

    invoke<string | null>("get_setting", {
      key: "branchPrefixCustom",
      scope: "global",
    }).then((v) => {
      if (v) setCustomPrefix(v);
    });

    invoke<string | null>("get_setting", {
      key: "worktreeBaseDir",
      scope: "global",
    }).then((v) => setWorktreeBaseDir(v));

    invoke<string>("get_default_worktree_base_dir").then((v) =>
      setDefaultBaseDir(v),
    );

    invoke<GitInfo>("get_git_info").then((info) => setGitInfo(info));
  }, []);

  const handleDeleteBranchToggle = () => {
    const next = !deleteBranch;
    setDeleteBranch(next);
    invoke("set_setting", {
      key: "deleteLocalBranch",
      scope: "global",
      value: String(next),
    });
  };

  const handlePrefixModeChange = (mode: BranchPrefixMode) => {
    setPrefixMode(mode);
    invoke("set_setting", {
      key: "branchPrefixMode",
      scope: "global",
      value: mode,
    });
  };

  const handleCustomPrefixBlur = () => {
    const sanitized = sanitizePrefix(customPrefix);
    setCustomPrefix(sanitized);
    invoke("set_setting", {
      key: "branchPrefixCustom",
      scope: "global",
      value: sanitized,
    });
  };

  const handleBrowse = async () => {
    const selected = await open({
      directory: true,
      title: "Select worktree base directory",
      defaultPath: worktreeBaseDir ?? defaultBaseDir,
    });
    if (selected) {
      setWorktreeBaseDir(selected as string);
      invoke("set_setting", {
        key: "worktreeBaseDir",
        scope: "global",
        value: selected as string,
      });
    }
  };

  const handleResetDir = () => {
    setWorktreeBaseDir(null);
    invoke("delete_setting", { key: "worktreeBaseDir", scope: "global" });
  };

  const previewPrefix = resolvePreviewPrefix(prefixMode, customPrefix, gitInfo);

  return (
    <div>
      <h2 className="text-base font-semibold text-foreground">
        Git & Worktrees
      </h2>
      <p className="text-md text-muted-foreground mt-1 mb-6">
        Configure git branch and worktree behavior
      </p>

      <div className="flex items-center justify-between max-w-2xl">
        <div>
          <div className="text-md font-medium">
            Delete local branch on workspace removal
          </div>
          <div className="text-md text-muted-foreground mt-0.5">
            Also delete the local git branch when deleting a worktree workspace
          </div>
        </div>
        <button
          onClick={handleDeleteBranchToggle}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
            deleteBranch ? "bg-primary" : "bg-muted-foreground/30"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-background transition-transform ${
              deleteBranch ? "translate-x-[18px]" : "translate-x-[3px]"
            }`}
          />
        </button>
      </div>

      <div className="mt-8 max-w-2xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-md font-medium">Branch Prefix</div>
            <div className="text-md text-muted-foreground mt-0.5">
              Preview:{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded text-foreground text-md">
                {previewPrefix
                  ? `${previewPrefix}/branch-name`
                  : "branch-name"}
              </code>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={prefixMode}
              onChange={(e) =>
                handlePrefixModeChange(e.target.value as BranchPrefixMode)
              }
              className="px-3 py-1.5 border rounded text-sm bg-background"
            >
              {(
                Object.entries(BRANCH_PREFIX_LABELS) as [
                  BranchPrefixMode,
                  string,
                ][]
              ).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {prefixMode === "custom" && (
              <input
                type="text"
                value={customPrefix}
                onChange={(e) => setCustomPrefix(e.target.value)}
                onBlur={handleCustomPrefixBlur}
                placeholder="prefix"
                className="w-[120px] px-3 py-1.5 border rounded text-sm bg-background"
                spellCheck={false}
              />
            )}
          </div>
        </div>
      </div>

      <div className="mt-8 max-w-2xl">
        <div className="text-md font-medium">Worktree location</div>
        <div className="text-md text-muted-foreground mt-0.5 mb-2">
          Base directory for new worktrees
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 px-3 py-1.5 border rounded text-sm bg-background text-muted-foreground truncate">
            {worktreeBaseDir ?? `Default (${defaultBaseDir})`}
          </div>
          <button
            onClick={handleBrowse}
            className="px-3 py-1.5 text-sm border rounded hover:bg-accent/10 shrink-0"
          >
            Browse...
          </button>
          {worktreeBaseDir && (
            <button
              onClick={handleResetDir}
              className="px-3 py-1.5 text-sm border rounded hover:bg-accent/10 text-muted-foreground shrink-0"
            >
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
