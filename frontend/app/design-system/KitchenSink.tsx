import { Suspense, use } from "react";
import type { ReactElement } from "react";

import { Link } from "./components/Link";
import type { DemoSection } from "./demo-registry";
import { t, tPlural } from "./foundation/strings";
import styles from "./KitchenSink.module.css";

/** Anchor id of a demo section; component names are plain words. */
function anchor(name: string): string {
  return `demo-${name}`;
}

/**
 * Holds the place of a section whose demo is still on its way. It carries the id and the name the
 * section will have, but not `data-demo`: that marks a section whose specimens are on the page, so
 * a test that waits for `[data-demo="Name"]` cannot read a section that is not there yet.
 */
function Placeholder({ name }: { readonly name: string }): ReactElement {
  return (
    <section
      id={anchor(name)}
      aria-labelledby={`${anchor(name)}-title`}
      aria-busy="true"
      className={styles.demo}
    >
      <h2 id={`${anchor(name)}-title`}>{name}</h2>
    </section>
  );
}

/** One component's specimens. It suspends until the chunk with the demo has arrived. */
function LoadedSection({ section }: { readonly section: DemoSection }): ReactElement {
  const demo = use(section.load());
  return (
    <section
      id={anchor(demo.name)}
      aria-labelledby={`${anchor(demo.name)}-title`}
      data-demo={demo.name}
      className={styles.demo}
    >
      <h2 id={`${anchor(demo.name)}-title`}>{demo.name}</h2>
      <p className={styles.description}>{demo.description}</p>
      <div className={styles.states}>
        {demo.states.map((state) => (
          <figure key={state.id} data-state={state.id} className={styles.specimen}>
            <div className={styles.stage}>{state.node}</div>
            <figcaption className={styles.caption}>{state.title}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

export interface KitchenSinkProps {
  /** The sections to show, in page order. Each one loads its demo on its own. */
  readonly sections: readonly DemoSection[];
  /** Names that were asked for and that no component has. */
  readonly unknown: readonly string[];
  /** Whether the page shows only some of the components, because it was asked to. */
  readonly isFiltered: boolean;
}

/**
 * Every demo, every state: the page behind `/design`. Design review reads it, and the Playwright
 * goldens and axe run take their pictures of it. It shows the theme the page is in; flip the
 * toggle in the header to see the other (the goldens do both).
 *
 * The list of components is on the page at once, and each section appears when its demo has
 * loaded: until then a placeholder with the same id and heading, marked busy, holds its place. The
 * address can ask for some sections only, `/design?section=Tooltip`, which then are the only ones
 * that load; the page says so and links back to the whole of it.
 */
export function KitchenSink({ sections, unknown, isFiltered }: KitchenSinkProps): ReactElement {
  return (
    <div className={styles.sink}>
      <header className={styles.intro}>
        <h1>{t("design.title")}</h1>
        <p>{t("design.intro")}</p>
        {unknown.length > 0 ? (
          <p>{tPlural("design.unknown", unknown.length, { names: unknown.join(", ") })}</p>
        ) : null}
        {sections.length > 0 ? (
          <nav aria-label={t("design.index")}>
            <ul className={styles.index}>
              {sections.map((section) => (
                <li key={section.name}>
                  <a href={`#${anchor(section.name)}`}>{section.name}</a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        {isFiltered ? (
          <p>
            <Link href="/design">{t("design.showAll")}</Link>
          </p>
        ) : null}
      </header>
      {sections.map((section) => (
        <Suspense key={section.name} fallback={<Placeholder name={section.name} />}>
          <LoadedSection section={section} />
        </Suspense>
      ))}
    </div>
  );
}
