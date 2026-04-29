import { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { Fzf, type FzfResultItem } from "fzf";
import { useUIStore } from "../store";
import { useAllFiles } from "../hooks/useAllFiles";
import { openFileTab } from "../lib/tab-actions";
import { basename, dirname } from "../lib/path-utils";

const MAX_RESULTS = 50;

export function FileFinder({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const worktreePath = selectedWorktree?.path ?? null;
  const { paths, loading, load } = useAllFiles(worktreePath);

  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset query and refresh the file list whenever the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    void load();
    requestAnimationFrame(() => inputRef.current?.focus());
    // load() and worktreePath are stable per-open; we deliberately only
    // re-run on `open` flips so reopening always refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Defer Fzf construction until the user actually types — `new Fzf` runes
  // every path up front, which is meaningful work on 10k+ inventories.
  const hasQuery = query.trim().length > 0;
  const fzf = useMemo(() => {
    if (!hasQuery || paths.length === 0) return null;
    return new Fzf(paths, { limit: MAX_RESULTS });
  }, [paths, hasQuery]);

  const results = useMemo<FzfResultItem<string>[]>(() => {
    if (!fzf) return [];
    return fzf.find(query);
  }, [fzf, query]);

  const recents = useMemo<string[]>(() => {
    if (!worktreePath) return [];
    const nav = useUIStore.getState().worktreeNavStates[worktreePath];
    if (!nav) return [];
    return nav.userTabs
      .filter((t) => t.kind === "file" && t.path)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => t.path as string)
      .slice(0, 10);
  }, [worktreePath, open]);

  if (!open) return null;

  const openPath = (path: string, pin: boolean) => {
    if (!worktreePath) return;
    openFileTab(worktreePath, path, pin);
    onClose();
  };

  // Cmd+Enter: pin the highlighted item. cmdk doesn't expose the highlighted
  // value directly; we derive it from the active [data-selected="true"] item
  // inside the list at the time the key is pressed.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const root = e.currentTarget;
      const selected = root.querySelector<HTMLElement>(
        '[cmdk-item][data-selected="true"]',
      );
      const path = selected?.dataset.path;
      if (path) openPath(path, true);
    }
  };

  const showResults = query.trim().length > 0;
  const showRecents = !showResults && recents.length > 0;

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="fixed inset-0 bg-black/40" />
      <div
        className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-[640px]"
        onClick={(e) => e.stopPropagation()}
      >
        <Command
          className="rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
          loop
          shouldFilter={false}
          onKeyDown={handleKeyDown}
        >
          <div className="flex items-center border-b border-border px-3">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-muted-foreground/90 mr-2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder={
                worktreePath
                  ? "Search files by name..."
                  : "Select a worktree to search files"
              }
              className="flex h-10 w-full bg-transparent py-3 text-sm text-foreground placeholder:text-muted-foreground/90 outline-none"
            />
          </div>
          <Command.List className="max-h-[400px] overflow-y-auto p-1.5">
            {showResults && results.length === 0 && (
              <Command.Empty className="py-6 text-center text-md text-muted-foreground">
                {loading ? "Indexing files..." : "No files match."}
              </Command.Empty>
            )}

            {!showResults && !showRecents && (
              <Command.Empty className="py-6 text-center text-md text-muted-foreground">
                {loading
                  ? "Indexing files..."
                  : worktreePath
                    ? "Type to search files."
                    : "No worktree selected."}
              </Command.Empty>
            )}

            {showRecents && (
              <Command.Group
                heading="Recent"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-md [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[1.2px] [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:font-semibold"
              >
                {recents.map((path) => (
                  <FileItem
                    key={`recent-${path}`}
                    path={path}
                    onSelect={() => openPath(path, false)}
                  />
                ))}
              </Command.Group>
            )}

            {showResults && results.length > 0 && (
              <Command.Group
                heading="Files"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-md [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[1.2px] [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:font-semibold"
              >
                {results.map((r) => (
                  <FileItem
                    key={r.item}
                    path={r.item}
                    onSelect={() => openPath(r.item, false)}
                  />
                ))}
              </Command.Group>
            )}
          </Command.List>
          <div className="flex items-center justify-end gap-3 border-t border-border px-3 py-1.5 text-md text-muted-foreground/80">
            <span>
              <kbd className="font-mono">↵</kbd> open
            </span>
            <span>
              <kbd className="font-mono">⌘↵</kbd> pin
            </span>
            <span>
              <kbd className="font-mono">esc</kbd> close
            </span>
          </div>
        </Command>
      </div>
    </div>
  );
}

function FileItem({
  path,
  onSelect,
}: {
  path: string;
  onSelect: () => void;
}) {
  const name = basename(path);
  const dir = dirname(path);
  return (
    <Command.Item
      value={path}
      onSelect={onSelect}
      data-path={path}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-md cursor-pointer data-[selected=true]:bg-accent"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-muted-foreground/90"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-foreground truncate">{name}</span>
      {dir && (
        <span className="ml-auto text-muted-foreground/80 truncate pl-2">
          {dir}
        </span>
      )}
    </Command.Item>
  );
}
