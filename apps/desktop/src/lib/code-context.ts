export interface ContextLine {
  lineNumber: number;
  text: string;
}

/**
 * Extracts the annotated line plus its immediate neighbors (within the same
 * hunk) from a unified-diff string. Returns up to 3 entries ordered by line
 * number, or [] if the line cannot be located in the diff.
 */
export function extractCodeContext(
  diffText: string,
  lineNumber: number,
  side: "left" | "right"
): ContextLine[] {
  const wantAdditions = side === "right";
  const lines = diffText.split("\n");

  let hunkLines: ContextLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  // Returns the target line ± 1 neighbor from the current hunk, or [].
  const sliceAroundTarget = (): ContextLine[] => {
    const idx = hunkLines.findIndex((l) => l.lineNumber === lineNumber);
    if (idx === -1) return [];
    return hunkLines.slice(Math.max(0, idx - 1), idx + 2);
  };

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      const found = sliceAroundTarget();
      if (found.length > 0) return found;
      oldLine = parseInt(header[1], 10);
      newLine = parseInt(header[2], 10);
      hunkLines = [];
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    const marker = line[0];
    const text = line.slice(1);
    if (marker === " " || line === "") {
      hunkLines.push({ lineNumber: wantAdditions ? newLine : oldLine, text });
      oldLine++;
      newLine++;
    } else if (marker === "+") {
      if (wantAdditions) hunkLines.push({ lineNumber: newLine, text });
      newLine++;
    } else if (marker === "-") {
      if (!wantAdditions) hunkLines.push({ lineNumber: oldLine, text });
      oldLine++;
    }
    // Any other marker (e.g. "\ No newline at end of file") is ignored.
  }

  return sliceAroundTarget();
}
