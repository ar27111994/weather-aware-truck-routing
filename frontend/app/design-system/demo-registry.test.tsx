import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEMO_MODULES } from "../../test/demos";
import { expectNoAxeViolations } from "../../test/axe";
import { VOICE_RULES } from "../../test/voice";
import { collectDemos } from "./demo-registry";
import type { Demo } from "./foundation/demo";
import { KitchenSink } from "./KitchenSink";

const demo = (name: string, ids: readonly string[] = ["only"]): { demo: Demo } => ({
  demo: {
    name,
    description: `${name} description`,
    states: ids.map((id) => ({ id, title: id, node: <span>{id}</span> })),
  },
});

describe("collectDemos", () => {
  it("returns the demos sorted by component name", () => {
    const demos = collectDemos({
      "./b.demo.tsx": demo("Banner"),
      "./a.demo.tsx": demo("Avatar"),
      "./c.demo.tsx": demo("Card"),
    });

    expect(demos.map((entry) => entry.name)).toEqual(["Avatar", "Banner", "Card"]);
  });

  it("fails loudly on a demo file that exports no demo", () => {
    expect(() => collectDemos({ "./Broken/Broken.demo.tsx": {} })).toThrow(
      './Broken/Broken.demo.tsx must export a "demo".',
    );
  });

  it("fails loudly when two demos share a name", () => {
    expect(() => collectDemos({ "./a": demo("Card"), "./b": demo("Card") })).toThrow(
      'Two demos are named "Card".',
    );
  });

  it("fails loudly on a demo with no states", () => {
    expect(() => collectDemos({ "./a": demo("Card", []) })).toThrow(
      'The "Card" demo has no states.',
    );
  });

  it("fails loudly on a demo that repeats a state id", () => {
    expect(() => collectDemos({ "./a": demo("Card", ["x", "x"]) })).toThrow(
      'The "Card" demo repeats a state id.',
    );
  });
});

describe("the real component demos", () => {
  const demos = collectDemos(DEMO_MODULES);
  const folders = Object.keys(import.meta.glob("./components/*/index.ts", { eager: false })).map(
    (path) => path.split("/")[2],
  );

  it("number one per component folder, and every folder has one", () => {
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      expect(Object.keys(DEMO_MODULES)).toContain(
        `../app/design-system/components/${String(folder)}/${String(folder)}.demo.tsx`,
      );
    }
    expect(demos).toHaveLength(folders.length);
  });

  // The documentation of a specimen (its description and the caption of each state) is written
  // beside the specimen, in `<Name>.demo.tsx`, because it states facts of that component (a delay,
  // a size) that change with it. It is not product copy, so it is not in `microcopy.json`, but the
  // voice of the product still holds for it: the page is public (D-27).
  it.each(VOICE_RULES)("documents every component without %s", (_rule, pattern) => {
    const prose = demos.flatMap((entry) => [
      entry.description,
      ...entry.states.map((state) => state.title),
    ]);

    expect(prose.filter((text) => pattern.test(text))).toEqual([]);
  });

  it.each(demos.map((entry) => [entry.name, entry] as const))(
    "%s renders every state and has no accessibility violations",
    async (_name, entry) => {
      const { container } = render(<KitchenSink demos={[entry]} />);

      expect(container.querySelectorAll("figure")).toHaveLength(entry.states.length);
      await expectNoAxeViolations(document.body);
    },
  );
});
