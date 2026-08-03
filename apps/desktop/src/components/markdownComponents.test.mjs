import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "./markdownComponents";

describe("markdown task lists", () => {
  test("keeps inline acceptance-criterion content in one text flow", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm], components: markdownComponents },
        "- [ ] better-auth pinned at `1.6.24` in `apps/web`",
      ),
    );

    const itemClass = html.match(/<li class="([^"]*)"/)?.[1] ?? "";
    expect(itemClass).not.toContain("flex");
    expect(itemClass).toContain("[&amp;&gt;input]:mr-2");
  });
});
