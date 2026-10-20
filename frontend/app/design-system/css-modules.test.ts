import { describe, expectTypeOf, it } from "vitest";

import badge from "./components/Badge/Badge.module.css";

/**
 * Every `*.module.css` has a generated declaration (`cmk`, see `pnpm styles:types`), so a class
 * name that is not in the stylesheet is a compile error instead of a component that quietly
 * renders without its class. Vitest does not process CSS (a module is a stand-in that returns
 * whatever key is asked for), so no runtime test can see a misspelled class; the check is the
 * type of the module, and `pnpm typecheck` is what runs it.
 */
describe("typed CSS modules", () => {
  it("lists exactly the classes the stylesheet defines", () => {
    expectTypeOf(badge).toEqualTypeOf<{ readonly badge: string; readonly shape: string }>();
  });

  it("rejects a class the stylesheet does not define", () => {
    expectTypeOf(badge).not.toHaveProperty("badgee");
  });
});
