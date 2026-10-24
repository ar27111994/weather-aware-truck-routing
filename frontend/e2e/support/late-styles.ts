import type { Page, Route } from "@playwright/test";

/**
 * A stylesheet's address: `/assets/<name>-<hash>.css`. The router's plugin ties a `#` to the
 * address of the stylesheets that a lazy chunk also loads, so a mark or a query may follow.
 */
const STYLESHEET = /\.css(?:[?#].*)?$/u;

/** The stylesheets that the page asks for, held back until the test lets them through. */
export interface HeldStyles {
  /** From now on, every stylesheet that the page asks for waits. The ones it already has stay. */
  readonly hold: () => void;
  /** How many stylesheets wait now. */
  readonly count: () => number;
  /**
   * Lets the waiting stylesheets, and every later one, through, and returns once the page has
   * drawn them: every stylesheet link has loaded and two frames have been painted, so a layout
   * that the new styles change has changed by the time this settles.
   */
  readonly release: () => Promise<void>;
}

/**
 * Holds back the stylesheets that the page asks for after `hold()`, the way a slow link would,
 * so that a test decides when they arrive. The planner's code brings its stylesheets with it, and
 * the visitor's first input is what asks for that code (the ADR in
 * docs/adr/intent-gated-hydration-of-the-planner.md): `hold()` after the page has loaded, and the
 * styles that the first input asks for wait, while the page's own stylesheets have long arrived.
 *
 * The test lets them through by events and promises, never by a pause: the pointer goes down, the
 * styles are released and drawn, and only then does the pointer go up.
 *
 * @param page - The page under test.
 */
export async function holdStylesheets(page: Page): Promise<HeldStyles> {
  const waiting: Route[] = [];
  let holding = false;
  await page.route(STYLESHEET, (route) => {
    if (holding) waiting.push(route);
    else void route.continue();
  });
  return {
    hold: () => {
      holding = true;
    },
    count: () => waiting.length,
    release: async () => {
      holding = false;
      for (const route of waiting.splice(0)) await route.continue();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).every(
          (link) => link.sheet !== null,
        ),
      );
      // Two frames: the styles that have arrived have been applied and laid out after the first.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          }),
      );
    },
  };
}
