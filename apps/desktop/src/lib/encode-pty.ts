export function encodePtyInput(text: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(text), (b) =>
      String.fromCharCode(b)
    ).join("")
  );
}
