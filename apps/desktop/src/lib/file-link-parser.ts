export interface FileLink {
  path: string;
  line?: number;
  col?: number;
  startIndex: number;
  endIndex: number;
}

const STANDARD_RE = /((?:\.?\.?\/)?[\w@./-]+\.\w+)(?::(\d+)(?::(\d+))?)?/g;
const PYTHON_RE = /File "([^"]+)", line (\d+)/g;
const PAREN_RE = /((?:\.?\.?\/)?[\w@./-]+\.\w+)\((\d+)(?:,(\d+))?\)/g;

export function parseFileLinks(text: string): FileLink[] {
  const links: FileLink[] = [];
  const seen = new Set<string>();

  function addMatch(re: RegExp) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const path = m[1];
      if (path.length < 3 || (!path.includes("/") && !path.includes("."))) continue;
      if (text.slice(Math.max(0, m.index - 8), m.index).match(/https?:\/\/$/)) continue;

      const key = `${m.index}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      links.push({
        path,
        line: m[2] ? parseInt(m[2], 10) : undefined,
        col: m[3] ? parseInt(m[3], 10) : undefined,
        startIndex: m.index,
        endIndex: m.index + m[0].length,
      });
    }
  }

  addMatch(PYTHON_RE);
  addMatch(PAREN_RE);
  addMatch(STANDARD_RE);

  links.sort((a, b) => a.startIndex - b.startIndex);
  return links.filter(
    (link, i) => i === 0 || link.startIndex >= links[i - 1].endIndex
  );
}
