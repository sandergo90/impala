import { invoke } from "@tauri-apps/api/core";

let cachedHookPort: number | null = null;

export async function getHookPort(): Promise<number> {
  if (cachedHookPort === null) {
    cachedHookPort = await invoke<number>("get_hook_port");
  }
  return cachedHookPort;
}
