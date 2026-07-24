export const MAX_RECENT_BROWSER_URLS = 50;

export function addRecentBrowserUrl(
  history: string[],
  url: string,
): string[] {
  return [url, ...history.filter((entry) => entry !== url)].slice(
    0,
    MAX_RECENT_BROWSER_URLS,
  );
}

export function filterRecentBrowserUrls(
  history: string[],
  query: string,
): string[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return history;
  return history.filter((url) =>
    url.toLocaleLowerCase().includes(normalizedQuery),
  );
}
