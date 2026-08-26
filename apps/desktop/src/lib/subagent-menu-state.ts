export function canShowSubagentMenu(kind: string) {
  return kind === "terminal" || kind === "agent";
}

export function formatSubagentAge(updatedAt: number, now = Date.now()) {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "";
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatSubagentName(name: string) {
  const displayName = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  return displayName
    ? displayName[0].toUpperCase() + displayName.slice(1)
    : "Subagent";
}

export function getSubagentTriggerState(
  currentCount: number,
  previousCount: number,
) {
  const count = currentCount + previousCount;
  return {
    visible: count > 0,
    count,
  };
}
