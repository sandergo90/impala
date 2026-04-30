const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  html: "html", htm: "html",
  css: "css", scss: "css", less: "css",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  yaml: "yaml", yml: "yaml",
  xml: "xml", svg: "xml",
  py: "python",
  rs: "rust",
  sql: "sql",
  php: "php",
  java: "java",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp",
  go: "go",
  sh: "shell", bash: "shell", zsh: "shell",
  toml: "toml",
  rb: "ruby",
  swift: "swift",
  cs: "csharp",
  kt: "kotlin", kts: "kotlin",
};

const FILENAME_TO_LANG: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  GNUmakefile: "makefile",
};

export function detectLanguage(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  if (FILENAME_TO_LANG[name]) return FILENAME_TO_LANG[name];
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot === name.length - 1) return "plaintext";
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? "plaintext";
}
