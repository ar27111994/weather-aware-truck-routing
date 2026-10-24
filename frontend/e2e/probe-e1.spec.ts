import type { Page } from "@playwright/test";

import { expect, test } from "./support/mock-api";
import { NOW, holdPlannerCode, wakePlanner } from "./support/planner";

// PROBE (throwaway, never merged), R4F-E1 round 1: why does the From field of early-input.spec.ts:174 stay
// empty after fill("salt") on Firefox, the Pixel 7 and the iPhone 14? Every test logs, in one ordered list
// (window.__probe): the events at window, the sets of the value of a combobox input with their stacks, what
// React has bound to the input at the moment of the `input` event (props, the value tracker, the refs of the
// hooks of the components above it) and the entries that the app itself pushes (probe() in app/probe.ts).
test.use({ locale: "en-US", timezoneId: "America/Denver" });

const FROM = /^From/u;

async function install(page: Page): Promise<void> {
  page.on("console", (message) => {
    console.log(`PAGECONSOLE ${message.type()} ${message.text().slice(0, 400)}`);
  });
  page.on("pageerror", (error) => {
    console.log(`PAGEERROR ${error.message.slice(0, 400)}`);
  });
  await page.addInitScript(() => {
    const log: Record<string, unknown>[] = [];
    Reflect.set(window, "__probe", log);
    const describe = (target: EventTarget | null): string => {
      if (!(target instanceof Element)) return String(target);
      const role = target.getAttribute("role");
      const id = target.id === "" ? "" : `#${target.id.slice(-8)}`;
      return `${target.localName}${id}${role === null ? "" : `[${role}]`}`;
    };
    // Who sets the value of a combobox input, and from where (minified frames, mapped by the build).
    const proto = HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set !== undefined && descriptor.get !== undefined) {
      const nativeSet = descriptor.set;
      Object.defineProperty(proto, "value", {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get: descriptor.get,
        set(this: HTMLInputElement, next: string) {
          if (this.getAttribute("role") === "combobox") {
            log.push({
              n: log.length,
              type: "value-set",
              value: next,
              was: this.value,
              stack: (new Error().stack ?? "")
                .split("\n")
                .slice(1, 9)
                .map((line) => line.trim().replace(/https?:\/\/[^/]+\/assets\//u, ""))
                .join(" | "),
            });
          }
          nativeSet.call(this, next);
        },
      });
    }
    // Is a combobox input ever taken out of the page or put in?
    new MutationObserver((records) => {
      for (const record of records) {
        for (const [kind, nodes] of [
          ["removed", record.removedNodes],
          ["added", record.addedNodes],
        ] as const) {
          for (const node of nodes) {
            if (
              node instanceof Element &&
              (node.matches("input[role='combobox']") ||
                node.querySelector("input[role='combobox']") !== null)
            ) {
              log.push({ n: log.length, type: `mutation-${kind}`, target: node.localName });
            }
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
    // What React has bound to an input: its props, its value tracker, the root it belongs to, and the
    // string refs of the hooks of every component above it (useControlledState keeps its value in one).
    const reactInfo = (el: HTMLInputElement): Record<string, unknown> => {
      const keys = Object.getOwnPropertyNames(el).filter((key) => key.startsWith("__react"));
      const fiberKey = keys.find((key) => key.startsWith("__reactFiber$"));
      const propsKey = keys.find((key) => key.startsWith("__reactProps$"));
      const props = propsKey === undefined ? null : (Reflect.get(el, propsKey) as Record<string, unknown>);
      const tracker = Reflect.get(el, "_valueTracker") as { getValue(): string } | undefined;
      const info: Record<string, unknown> = {
        keys: keys.map((key) => key.replace(/\$.*/u, "")),
        onChange: props === null ? "no-props" : typeof props["onChange"],
        propValue: props === null ? "no-props" : props["value"],
        readOnly: props === null ? null : props["readOnly"],
        disabled: props === null ? null : props["disabled"],
        tracker: tracker === undefined ? "no-tracker" : tracker.getValue(),
        domValue: el.value,
      };
      if (fiberKey === undefined) return info;
      interface Fiber {
        tag: number;
        type: unknown;
        return: Fiber | null;
        alternate: Fiber | null;
        stateNode: unknown;
        memoizedState: unknown;
        memoizedProps: Record<string, unknown> | null;
      }
      const start = Reflect.get(el, fiberKey) as Fiber;
      const nameOf = (type: unknown): string => {
        if (typeof type === "function") {
          const named = type as { displayName?: string; name: string };
          return named.displayName ?? named.name;
        }
        if (type !== null && typeof type === "object") {
          const inner = type as { render?: { name?: string }; type?: { name?: string } };
          return `obj:${inner.render?.name ?? inner.type?.name ?? "?"}`;
        }
        return String(type);
      };
      const refsOf = (fiber: Fiber): string[] => {
        const out: string[] = [];
        let hook = fiber.memoizedState as { memoizedState: unknown; next: unknown } | null;
        let guard = 0;
        while (hook !== null && typeof hook === "object" && guard < 80) {
          guard += 1;
          const state = hook.memoizedState;
          if (state !== null && typeof state === "object" && !Array.isArray(state) && "current" in state) {
            const current = (state as { current: unknown }).current;
            if (typeof current === "string") out.push(current);
          }
          hook = hook.next as typeof hook;
        }
        return out;
      };
      const chain: string[] = [];
      let fiber: Fiber | null = start;
      let hops = 0;
      let root: Fiber | null = null;
      while (fiber !== null) {
        if (fiber.tag === 3) root = fiber;
        const isComponent = fiber.tag === 0 || fiber.tag === 11 || fiber.tag === 15 || fiber.tag === 14;
        if (isComponent && chain.length < 14) {
          const refs = refsOf(fiber);
          const p = fiber.memoizedProps ?? {};
          const shown: Record<string, unknown> = {};
          for (const key of ["inputValue", "value", "text", "defaultInputValue"]) {
            if (typeof p[key] === "string") shown[key] = p[key];
          }
          const refText = refs.length > 0 ? ` refs=${JSON.stringify(refs)}` : "";
          const propText = Object.keys(shown).length > 0 ? ` props=${JSON.stringify(shown)}` : "";
          chain.push(`${nameOf(fiber.type)}${refText}${propText}`);
        }
        fiber = fiber.return;
        hops += 1;
      }
      info["hops"] = hops;
      info["components"] = chain;
      if (root !== null) {
        const rootNode = root.stateNode as { containerInfo: Element | Document; current: Fiber };
        const container = rootNode.containerInfo;
        info["rootContainer"] = container instanceof Document ? "document" : describe(container);
        info["rootDehydrated"] = Boolean(
          (rootNode.current.memoizedState as { isDehydrated?: boolean } | null)?.isDehydrated,
        );
        info["fiberIsCurrent"] = start === rootNode.current || start.alternate !== null;
      }
      return info;
    };
    Reflect.set(window, "__reactInfo", reactInfo);
    const types = [
      "pointerdown",
      "click",
      "focusin",
      "focusout",
      "beforeinput",
      "input",
      "change",
      "keydown",
      "compositionstart",
      "compositionend",
      "reset",
      "submit",
      "scroll",
    ];
    for (const type of types) {
      for (const capture of [true, false]) {
        window.addEventListener(
          type,
          (event) => {
            const target = event.target;
            const entry: Record<string, unknown> = {
              n: log.length,
              type,
              phase: capture ? "capture" : "bubble",
              target: describe(target),
              prevented: event.defaultPrevented,
              data: (event as InputEvent).data ?? null,
              inputType: (event as InputEvent).inputType ?? null,
              value: target instanceof HTMLInputElement ? target.value : null,
              active: describe(document.activeElement),
            };
            if (
              type === "input" &&
              target instanceof HTMLInputElement &&
              target.getAttribute("role") === "combobox"
            ) {
              entry["react"] = reactInfo(target);
            }
            log.push(entry);
          },
          capture,
        );
      }
    }
    let last: string | null = "unset";
    let polls = 0;
    setInterval(() => {
      const input = document.querySelector<HTMLInputElement>("input[role='combobox']");
      const value = input === null ? null : input.value;
      if (value !== last) {
        last = value;
        log.push({ n: log.length, type: "poll-value", value, polls });
      }
      polls += 1;
    }, 5);
  });
}

/** The prerendered page, the planner's code held; an interval is chosen; the code is let through. */
async function early(page: Page, interval = "10 mi"): Promise<void> {
  const held = await holdPlannerCode(page);
  await page.clock.setFixedTime(NOW);
  await page.goto("/");
  await page.getByText(interval, { exact: true }).click();
  await expect.poll(held.requested).toBe(true);
  await held.release();
  await settle(page);
}

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole("group", { name: "Date" })).toContainText("10/21/2026");
  await expect(page.locator("form")).not.toHaveAttribute("aria-busy", /.*/u);
}

async function report(page: Page, label: string): Promise<void> {
  const state = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("input[role='combobox']");
    const reactInfo = Reflect.get(window, "__reactInfo") as (el: HTMLInputElement) => unknown;
    return {
      log: Reflect.get(window, "__probe") as Record<string, unknown>[],
      active: document.activeElement?.outerHTML.slice(0, 160) ?? null,
      hasFocus: document.hasFocus(),
      busy: document.querySelector("form")?.getAttribute("aria-busy") ?? null,
      finalReact: input === null ? null : reactInfo(input),
      scrollTops: Array.from(document.querySelectorAll("*"))
        .filter((element) => element.scrollTop > 0)
        .map(
          (element) =>
            `${element.localName}.${element.getAttribute("class") ?? ""}:${String(element.scrollTop)}`,
        ),
    };
  });
  console.log(
    `PROBE ${label} ${JSON.stringify({ ...state, log: undefined })}\nPROBELOG ${label} ${JSON.stringify(state.log)}`,
  );
}

async function fillFrom(page: Page): Promise<void> {
  const from = page.getByRole("combobox", { name: FROM });
  await from.fill("salt");
  await page.waitForTimeout(800);
}

test.describe("probe", () => {
  test("A: the failing flow", async ({ page }) => {
    await install(page);
    await early(page);
    await fillFrom(page);
    await report(page, "A");
    await expect(page.getByRole("combobox", { name: FROM })).toHaveValue("salt");
  });

  test("D: control, the planner woken by the pointer", async ({ page }) => {
    await install(page);
    await page.clock.setFixedTime(NOW);
    await page.goto("/");
    await wakePlanner(page);
    await settle(page);
    await fillFrom(page);
    await report(page, "D");
    await expect(page.getByRole("combobox", { name: FROM })).toHaveValue("salt");
  });

  test("E: the failing flow, the field clicked before it is filled", async ({ page }) => {
    await install(page);
    await early(page);
    const from = page.getByRole("combobox", { name: FROM });
    await from.click();
    await from.fill("salt");
    await page.waitForTimeout(800);
    await report(page, "E");
    await expect(from).toHaveValue("salt");
  });

  test("V1: the failing flow, the radio blurred before the fill", async ({ page }) => {
    await install(page);
    await early(page);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await fillFrom(page);
    await report(page, "V1");
    await expect(page.getByRole("combobox", { name: FROM })).toHaveValue("salt");
  });

  test("V2: the failing flow, every scroll position reset before the fill", async ({ page }) => {
    await install(page);
    await early(page);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("*")) element.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await fillFrom(page);
    await report(page, "V2");
    await expect(page.getByRole("combobox", { name: FROM })).toHaveValue("salt");
  });

  test("V3: the interval set by a script click (no focus), the planner woken by the pointer", async ({
    page,
  }) => {
    await install(page);
    const held = await holdPlannerCode(page);
    await page.clock.setFixedTime(NOW);
    await page.goto("/");
    await page.evaluate(() => {
      document.querySelector<HTMLInputElement>('input[type="radio"][value="10"]')?.click();
    });
    await wakePlanner(page);
    await expect.poll(held.requested).toBe(true);
    await held.release();
    await settle(page);
    await fillFrom(page);
    await report(page, "V3");
    await expect(page.getByRole("combobox", { name: FROM })).toHaveValue("salt");
  });

  test("V5: the default interval (25 mi) clicked early: focus on the radio, no state to apply", async ({
    page,
  }) => {
    await install(page);
    await early(page, "25 mi");
    await fillFrom(page);
    await report(page, "V5");
    await expect(page.getByRole("combobox", { name: FROM })).toHaveValue("salt");
  });
});
