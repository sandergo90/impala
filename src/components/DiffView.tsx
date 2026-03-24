import { useAppStore } from "../store";
import { PatchDiff } from "@pierre/diffs/react";

export function DiffView() {
  const { selectedFile, diffText } = useAppStore();

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
        <span className="font-mono font-semibold text-xs">{selectedFile.path}</span>
      </div>
      <div className="flex-1 overflow-auto">
        <PatchDiff
          patch={diffText}
          options={{
            theme: "github-dark",
            overflow: "scroll",
          }}
        />
      </div>
    </div>
  );
}
