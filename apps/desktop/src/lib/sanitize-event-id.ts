export function sanitizeEventId(id: string): string {
  return id.replace(/[^a-zA-Z0-9\-_]/g, "-");
}
