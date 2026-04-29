import { useRef, type KeyboardEvent } from "react";
import { useFileTreeSearch } from "@pierre/trees/react";
import type { FileTree } from "@pierre/trees";

export function FileSearchInput({ model }: { model: FileTree }) {
  const search = useFileTreeSearch(model);
  const inputRef = useRef<HTMLInputElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      search.close();
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      search.focusNextMatch();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      search.focusPreviousMatch();
    }
  };

  return (
    <div className="px-3 py-2 border-b border-border shrink-0">
      <input
        ref={inputRef}
        type="text"
        value={search.value ?? ""}
        onChange={(e) => search.setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search files…"
        className="w-full px-2 py-1 text-sm bg-input rounded outline-none focus:ring-1 focus:ring-ring"
        data-files-search-input
      />
      {search.value && search.matchingPaths.length === 0 && (
        <div className="mt-1 text-xs text-muted-foreground">No matches</div>
      )}
    </div>
  );
}
