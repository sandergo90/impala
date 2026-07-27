export interface BrowserPageInfo {
  url: string;
}

export interface BrowserExternalDependencies {
  getPageInfo: (paneId: string) => Promise<BrowserPageInfo>;
  open: (url: string) => Promise<void>;
}

export async function openBrowserExternally(
  paneId: string,
  _persistedUrl: string,
  dependencies: BrowserExternalDependencies,
): Promise<void> {
  const pageInfo = await dependencies.getPageInfo(paneId);
  await dependencies.open(pageInfo.url);
}
