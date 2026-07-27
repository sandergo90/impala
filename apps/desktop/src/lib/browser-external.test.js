import { describe, expect, mock, test } from "bun:test";
import { openBrowserExternally } from "./browser-external.ts";

describe("open browser externally", () => {
  test("opens the native webview URL when persisted pane state is about:blank", async () => {
    const getPageInfo = mock(async () => ({
      url: "https://tavily.com/",
    }));
    const open = mock(async () => {});

    await openBrowserExternally("browser-pane", "about:blank", {
      getPageInfo,
      open,
    });

    expect(getPageInfo).toHaveBeenCalledWith("browser-pane");
    expect(open).toHaveBeenCalledWith("https://tavily.com/");
  });
});
