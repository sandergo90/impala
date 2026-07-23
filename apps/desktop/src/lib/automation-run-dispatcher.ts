export function createAutomationRunDispatcher<T extends { run_id: string }>(
  launch: (run: T) => void,
): (run: T) => boolean {
  const launchedRunIds = new Set<string>();

  return (run) => {
    if (launchedRunIds.has(run.run_id)) return false;
    launchedRunIds.add(run.run_id);
    launch(run);
    return true;
  };
}
