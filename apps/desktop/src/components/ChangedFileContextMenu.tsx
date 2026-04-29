import type { ReactNode } from "react";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { useUIStore } from "../store";

/**
 * Context menu for changed-file rows. "Reveal in Files" switches the right
 * sidebar to the Files tab, expands the path's ancestors, and selects the row.
 */
export function ChangedFileContextMenu({
  worktreePath,
  filePath,
  children,
}: {
  worktreePath: string;
  filePath: string;
  children: ReactNode;
}) {
  const revealFileInTree = useUIStore((s) => s.revealFileInTree);

  const items: ContextMenuItem[] = [
    {
      label: "Reveal in Files",
      onSelect: () => revealFileInTree(worktreePath, filePath),
    },
  ];

  return <ContextMenu items={items}>{children}</ContextMenu>;
}
