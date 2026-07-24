import { describe, expect, test } from "bun:test";
import {
  MAX_RECENT_BROWSER_URLS,
  addRecentBrowserUrl,
  filterRecentBrowserUrls,
} from "./browser-history.ts";

describe("browser URL history", () => {
  test("adds the newest URL first and deduplicates existing entries", () => {
    expect(
      addRecentBrowserUrl(
        ["http://localhost:3000", "https://example.com"],
        "https://example.com",
      ),
    ).toEqual(["https://example.com", "http://localhost:3000"]);
  });

  test("caps persisted history", () => {
    const history = Array.from(
      { length: MAX_RECENT_BROWSER_URLS },
      (_, index) => `https://example.com/${index}`,
    );

    const next = addRecentBrowserUrl(history, "https://new.example.com");

    expect(next).toHaveLength(MAX_RECENT_BROWSER_URLS);
    expect(next[0]).toBe("https://new.example.com");
    expect(next).not.toContain(
      `https://example.com/${MAX_RECENT_BROWSER_URLS - 1}`,
    );
  });

  test("filters case-insensitively and preserves recency order", () => {
    const history = [
      "https://docs.example.com/Guide",
      "http://localhost:3000",
      "https://example.com",
    ];

    expect(filterRecentBrowserUrls(history, "EXAMPLE")).toEqual([
      "https://docs.example.com/Guide",
      "https://example.com",
    ]);
    expect(filterRecentBrowserUrls(history, "  ")).toEqual(history);
  });
});
