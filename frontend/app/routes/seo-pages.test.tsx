import type { MetaDescriptor } from "react-router";
import { describe, expect, it, vi } from "vitest";

// A build whose VITE_SITE_URL is set but empty (a `VITE_SITE_URL=` line in a .env file, an empty
// variable in a hosting dashboard). The pages read the origin as they load, so they are loaded
// after the variable is set. Loading them here, at the top of the file, keeps the slow import of
// the planner out of the 5 s that a test has.
vi.stubEnv("VITE_SITE_URL", "");
const { meta: homeMeta } = await import("./home");
const { meta: methodologyMeta } = await import("./methodology");

/**
 * The tags of a page as the build makes them, with the variable still set but empty. Vitest puts
 * the environment back before each test; a page that read the variable again when it makes its
 * tags would then read it as unset, and this file would not see the difference it looks for.
 */
function tagsOf(meta: () => MetaDescriptor[]): MetaDescriptor[] {
  vi.stubEnv("VITE_SITE_URL", "");
  return meta();
}

describe("the pages of a build whose VITE_SITE_URL is set but empty (RT-F1)", () => {
  it.each([
    ["/", homeMeta],
    ["/methodology", methodologyMeta],
  ])("%s leaves out every absolute address, as a build with no variable does", (_path, meta) => {
    expect(JSON.stringify(tagsOf(meta))).not.toMatch(/canonical|og:url|og:image|twitter:image/);
  });

  it.each([
    ["/", homeMeta],
    ["/methodology", methodologyMeta],
  ])("%s names itself in its structured data without an address", (_path, meta) => {
    const blocks = tagsOf(meta).filter((tag) => "script:ld+json" in tag);

    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of blocks) {
      expect(JSON.stringify(block)).not.toMatch(/"url"|mainEntityOfPage/);
    }
  });
});
