import { invoke } from "@/lib/invoke";

let cachedHookPort: number | null = null;

export async function getHookPort(): Promise<number> {
  if (cachedHookPort === null) {
    cachedHookPort = await invoke<number>("get_hook_port");
  }
  return cachedHookPort;
}
