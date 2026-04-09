import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore } from "../store";

export async function openFileInEditor(
  path: string,
  line?: number,
  col?: number,
): Promise<void> {
  const editor = useUIStore.getState().preferredEditor || "cursor";
  try {
    await invoke("open_in_editor", { editor, path, line: line ?? null, col: col ?? null });
  } catch (e) {
    toast.error(String(e));
  }
}
