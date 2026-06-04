import { invoke } from "@/lib/invoke";

const LINEAR_PREFIX = "https://uploads.linear.app/";

const cache = new Map<string, string>();
const CACHE_LIMIT = 50;

export function isLinearAttachment(src: string): boolean {
  return src.startsWith(LINEAR_PREFIX);
}

export async function fetchLinearAttachment(
  apiKey: string,
  url: string,
): Promise<string> {
  const cached = cache.get(url);
  if (cached) return cached;
  const dataUrl = await invoke<string>("fetch_linear_attachment", { apiKey, url });
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(url, dataUrl);
  return dataUrl;
}
