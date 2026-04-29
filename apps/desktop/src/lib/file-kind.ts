export type FileKind = "image" | "svg" | "binary" | "text";

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "apng", "tiff",
]);

const BINARY_EXTS = new Set([
  // Executables / libs
  "exe", "dll", "so", "dylib", "wasm", "o", "a", "lib",
  // Archives
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "tgz",
  // Media
  "mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg",
  // Documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // Fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // DBs
  "sqlite", "sqlite3", "db",
]);

export function classifyFile(path: string): FileKind {
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot === path.length - 1) return "text";
  const ext = path.slice(dot + 1).toLowerCase();
  if (ext === "svg") return "svg";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (BINARY_EXTS.has(ext)) return "binary";
  return "text";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const TEXT_SIZE_CAP_BYTES = 1024 * 1024; // 1 MB
