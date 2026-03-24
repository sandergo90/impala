import { useAppStore } from "../store";
import { PatchDiff } from "@pierre/diffs/react";

export function DiffView() {
  const { selectedFile, diffText, diffStyle, setDiffStyle, wrap, setWrap } = useAppStore();

  if (!selectedFile || !diffText) {
    return (
      <div className="flex items-center justify-center h-full flex-1 text-sm text-muted-foreground">
        Select a file to view its diff
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full flex-1 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 border-b">
        <span className="font-mono font-semibold text-xs flex-1">{selectedFile.path}</span>
        <div className="flex items-center gap-1 text-xs">
          <button
            onClick={() => setDiffStyle('split')}
            className={`px-2 py-0.5 rounded ${
              diffStyle === 'split'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Split
          </button>
          <button
            onClick={() => setDiffStyle('unified')}
            className={`px-2 py-0.5 rounded ${
              diffStyle === 'unified'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Unified
          </button>
          <span className="mx-1 text-border">|</span>
          <button
            onClick={() => setWrap(!wrap)}
            className={`px-2 py-0.5 rounded ${
              wrap
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Wrap
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <PatchDiff
          patch={diffText}
          options={{
            theme: "github-dark",
            overflow: wrap ? "wrap" : "scroll",
            diffStyle,
          }}
        />
      </div>
    </div>
  );
}
