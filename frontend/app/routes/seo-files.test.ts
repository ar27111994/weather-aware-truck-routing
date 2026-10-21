import { describe, expect, it } from "vitest";

import { loader as llmsFull } from "./llms-full";
import { loader as llms } from "./llms";
import { loader as robots } from "./robots";
import { loader as sitemap } from "./sitemap";

describe("the files written next to the pages at build time", () => {
  it.each([
    ["robots.txt", robots, "text/plain; charset=utf-8", "User-agent: *"],
    ["sitemap.xml", sitemap, "application/xml; charset=utf-8", "<urlset"],
    ["llms.txt", llms, "text/plain; charset=utf-8", "# Haulcast"],
    ["llms-full.txt", llmsFull, "text/plain; charset=utf-8", "## Risk thresholds"],
  ])("%s answers with its own type and its text", async (_name, loader, type, text) => {
    const response = loader();

    expect(response.headers.get("Content-Type")).toBe(type);
    expect(await response.text()).toContain(text);
  });
});
