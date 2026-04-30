interface BufferEntry {
  baseline: string;
  current: string;
  initialized: boolean;
}

const buffers = new Map<string, BufferEntry>();

export function buildDocumentKey(worktreePath: string, filePath: string): string {
  return `${worktreePath}::${filePath}`;
}

function ensure(key: string): BufferEntry {
  let entry = buffers.get(key);
  if (!entry) {
    entry = { baseline: "", current: "", initialized: false };
    buffers.set(key, entry);
  }
  return entry;
}

export function setLoaded(key: string, content: string): void {
  const e = ensure(key);
  e.baseline = content;
  e.current = content;
  e.initialized = true;
}

export function setCurrent(key: string, content: string): void {
  const e = ensure(key);
  if (!e.initialized) {
    e.baseline = content;
    e.initialized = true;
  }
  e.current = content;
}

export function markSaved(key: string, savedContent: string): void {
  const e = ensure(key);
  e.baseline = savedContent;
  e.initialized = true;
}

export function discard(key: string): string {
  const e = ensure(key);
  e.current = e.baseline;
  return e.current;
}

export function getCurrent(key: string): string {
  return buffers.get(key)?.current ?? "";
}

export function getBaseline(key: string): string {
  return buffers.get(key)?.baseline ?? "";
}

export function isInitialized(key: string): boolean {
  return buffers.get(key)?.initialized ?? false;
}

export function deleteBuffer(key: string): void {
  buffers.delete(key);
}
