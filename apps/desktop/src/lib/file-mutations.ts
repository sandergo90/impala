import { invoke } from "@/lib/invoke";
import { toast } from "sonner";

function abs(worktreePath: string, relativePath: string): string {
  return relativePath ? `${worktreePath}/${relativePath}` : worktreePath;
}

async function run(label: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    toast.error(`${label}: ${e}`);
    return false;
  }
}

export function createFile(
  worktreePath: string,
  relativePath: string,
): Promise<boolean> {
  return run("Create file failed", () =>
    invoke("fs_create_file", { absolutePath: abs(worktreePath, relativePath) }),
  );
}

export function createDirectory(
  worktreePath: string,
  relativePath: string,
): Promise<boolean> {
  return run("Create folder failed", () =>
    invoke("fs_create_directory", {
      absolutePath: abs(worktreePath, relativePath),
    }),
  );
}

export function renamePath(
  worktreePath: string,
  fromRelative: string,
  toRelative: string,
): Promise<boolean> {
  return run("Rename failed", () =>
    invoke("fs_rename", {
      fromAbsolute: abs(worktreePath, fromRelative),
      toAbsolute: abs(worktreePath, toRelative),
    }),
  );
}

export function deletePath(
  worktreePath: string,
  relativePath: string,
): Promise<boolean> {
  return run("Delete failed", () =>
    invoke("fs_delete", { absolutePath: abs(worktreePath, relativePath) }),
  );
}
