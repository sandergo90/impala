export function getSubagentTriggerState(
  currentCount: number,
  previousCount: number,
) {
  const historyOnly = currentCount === 0 && previousCount > 0;
  return {
    visible: currentCount > 0 || previousCount > 0,
    count: historyOnly ? previousCount : currentCount,
    historyOnly,
  };
}
