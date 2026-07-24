export function getSubagentTriggerState(currentCount: number) {
  // Previous runs are archived on UserPromptSubmit — the tab badge only
  // counts this turn's agents, so it disappears once a new message starts
  // a turn without subagents. History stays reachable from the menu's
  // "Previous runs" section whenever agents run again.
  return {
    visible: currentCount > 0,
    count: currentCount,
  };
}
