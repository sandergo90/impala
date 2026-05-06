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

/** Join a relative POSIX path against a base directory, resolving `.` and `..`. */
export function joinRelative(baseDir: string, rel: string): string {
  const segs = baseDir ? baseDir.split("/").filter(Boolean) : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length > 0) segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return segs.join("/");
}

/** True for fragment-only, protocol-relative, or absolute-scheme URLs (http, mailto, etc). */
export function isExternalHref(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("//") ||
    href.startsWith("#")
  );
}
