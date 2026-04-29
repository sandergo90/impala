/** Last segment of a POSIX path. Returns the input if no `/` is present. */
export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Parent dir of a POSIX path; returns "" for root-level paths. */
export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}
