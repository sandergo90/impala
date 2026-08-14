export function splitDiffByFile(fullDiff: string): Record<string, string> {
  const fileDiffs: Record<string, string> = {};
  // Git emits this line for merge conflicts, but @pierre/diffs cannot parse it.
  const cleaned = fullDiff.replace(/^\* Unmerged path .*\n?/gm, "");
  for (const part of cleaned.split(/^diff --git /m).filter(Boolean)) {
    const patch = `diff --git ${part}`;
    const match = patch.match(/^diff --git a\/(.*?) b\//);
    if (match) fileDiffs[match[1]] = patch;
  }
  return fileDiffs;
}
