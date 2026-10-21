import { waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations, warmUpAxe } from "../../test/axe";
import { defined } from "../../test/defined";
import { DEMO_LOADERS, DEMO_MODULES, sectionOf } from "../../test/demos";
import { renderAsync } from "../../test/render-async";
import { VOICE_RULES } from "../../test/voice";
import { collectDemos, collectSections, selectSections } from "./demo-registry";
import type { DemoModule } from "./demo-registry";
import type { Demo } from "./foundation/demo";
import { KitchenSink } from "./KitchenSink";

const demo = (name: string, ids: readonly string[] = ["only"]): { demo: Demo } => ({
  demo: {
    name,
    description: `${name} description`,
    states: ids.map((id) => ({ id, title: id, node: <span>{id}</span> })),
  },
});

/** Where a component's demo file lives, as `import.meta.glob` names it. */
const demoPath = (name: string): string => `../components/${name}/${name}.demo.tsx`;

/** Loaders for components that exist, one per name. */
const loaders = (...names: readonly string[]): Record<string, () => Promise<DemoModule>> =>
  Object.fromEntries(names.map((name) => [demoPath(name), () => Promise.resolve(demo(name))]));

/** Waits until every section of the page has its demo, then returns the page. */
async function settled(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(container.querySelector('section[aria-busy="true"]')).toBeNull();
  });
  return container;
}

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

describe("collectSections", () => {
  it("lists the sections sorted by component name, which it reads from the file names", () => {
    const sections = collectSections(loaders("Card", "Avatar", "Banner"));

    expect(sections.map((section) => section.name)).toEqual(["Avatar", "Banner", "Card"]);
  });

  it("loads nothing until a section is asked for its demo", () => {
    const load = vi.fn(() => Promise.resolve(demo("Card")));

    collectSections({ [demoPath("Card")]: load });

    expect(load).not.toHaveBeenCalled();
  });

  it("loads a demo once and gives every caller the same promise, so that React can suspend on it", async () => {
    const load = vi.fn(() => Promise.resolve(demo("Card")));
    const section = defined(collectSections({ [demoPath("Card")]: load })[0], "the section");

    const first = section.load();
    const second = section.load();

    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect((await first).name).toBe("Card");
  });

  it("fails loudly when two demo files share a name", () => {
    expect(() =>
      collectSections({
        "../components/A/Card.demo.tsx": () => Promise.resolve(demo("Card")),
        "../components/B/Card.demo.tsx": () => Promise.resolve(demo("Card")),
      }),
    ).toThrow('Two demos are named "Card".');
  });

  it("fails, when the section is loaded, on a demo file that exports no demo", async () => {
    const section = defined(
      collectSections({ "./Broken/Broken.demo.tsx": () => Promise.resolve({}) })[0],
      "the section",
    );

    await expect(section.load()).rejects.toThrow('./Broken/Broken.demo.tsx must export a "demo".');
  });

  it("fails, when the section is loaded, on a demo that is not named like its file", async () => {
    const section = defined(
      collectSections({ [demoPath("Card")]: () => Promise.resolve(demo("Cart")) })[0],
      "the section",
    );

    await expect(section.load()).rejects.toThrow(
      `${demoPath("Card")} exports a demo named "Cart", not "Card".`,
    );
  });

  it("fails, when the section is loaded, on a demo with no states", async () => {
    const section = defined(
      collectSections({ [demoPath("Card")]: () => Promise.resolve(demo("Card", [])) })[0],
      "the section",
    );

    await expect(section.load()).rejects.toThrow('The "Card" demo has no states.');
  });

  it("fails, when the section is loaded, on a demo that repeats a state id", async () => {
    const section = defined(
      collectSections({ [demoPath("Card")]: () => Promise.resolve(demo("Card", ["x", "x"])) })[0],
      "the section",
    );

    await expect(section.load()).rejects.toThrow('The "Card" demo repeats a state id.');
  });
});

describe("selectSections", () => {
  const sections = collectSections(loaders("Avatar", "Banner", "Card"));
  const namesOf = (selected: readonly { readonly name: string }[]): string[] =>
    selected.map((section) => section.name);

  it("selects every section when none is asked for", () => {
    expect(selectSections(sections, [])).toEqual({ sections, unknown: [], isFiltered: false });
  });

  it("selects only the sections asked for, in the order of the page and not of the request", () => {
    const selection = selectSections(sections, ["Card", "Avatar"]);

    expect(namesOf(selection.sections)).toEqual(["Avatar", "Card"]);
    expect(selection.unknown).toEqual([]);
    expect(selection.isFiltered).toBe(true);
  });

  it("reports each name that no component has, once, in the order it was asked for", () => {
    const selection = selectSections(sections, ["Nope", "Card", "Nada", "Nope"]);

    expect(namesOf(selection.sections)).toEqual(["Card"]);
    expect(selection.unknown).toEqual(["Nope", "Nada"]);
    expect(selection.isFiltered).toBe(true);
  });

  it("selects no section when every name is unknown, and still says the page is filtered", () => {
    const selection = selectSections(sections, ["Nope"]);

    expect(selection.sections).toEqual([]);
    expect(selection.unknown).toEqual(["Nope"]);
    expect(selection.isFiltered).toBe(true);
  });

  it("ignores a blank name, so that an empty filter is no filter", () => {
    expect(selectSections(sections, [""])).toEqual({ sections, unknown: [], isFiltered: false });
    expect(namesOf(selectSections(sections, ["", "Card"]).sections)).toEqual(["Card"]);
  });
});

describe("the real component demos", () => {
  const demos = collectDemos(DEMO_MODULES);
  const sections = collectSections(DEMO_LOADERS);
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

  it("are found by name without loading them, and each loads the demo of that name", async () => {
    expect(sections.map((section) => section.name)).toEqual(demos.map((entry) => entry.name));

    const loaded = await Promise.all(sections.map((section) => section.load()));

    expect(loaded.map((entry) => entry.name)).toEqual(sections.map((section) => section.name));
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

  // axe-core builds its rule set on its first run: 1.2 s on a quiet machine and several times that
  // under the load of a full coverage run. That cost belongs to no test, so the hook pays it. Left
  // inside the first test it blew the 5 s limit, and the scan still running made every later test
  // fail with "Axe is already running".
  beforeAll(warmUpAxe);

  // One scan per state, not per component. A scan takes time in proportion to what it looks at (the
  // timeline Slider alone took 1.5 s on a quiet machine), so a unit this small stays far inside the
  // 5 s limit whatever the load, and a failure names the state.
  const states = demos.flatMap((entry) => entry.states.map((state) => [entry, state] as const));

  it.each(states.map(([entry, state]) => [`${entry.name}: ${state.id}`, entry, state] as const))(
    "%s has no accessibility violations",
    async (_name, entry, state) => {
      const { container } = await renderAsync(
        <KitchenSink
          sections={[sectionOf({ ...entry, states: [state] })]}
          unknown={[]}
          isFiltered={false}
        />,
      );
      await settled(container);

      await expectNoAxeViolations(document.body);
    },
  );

  // What spans the states of one component, which a scan of one state cannot see.
  it.each(demos.map((entry) => [entry.name, entry] as const))(
    "%s renders every state, and none repeats an id",
    async (_name, entry) => {
      const { container } = await renderAsync(
        <KitchenSink sections={[sectionOf(entry)]} unknown={[]} isFiltered={false} />,
      );
      await settled(container);

      expect(container.querySelectorAll("figure")).toHaveLength(entry.states.length);
      const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    },
  );
});
