import type { ReactElement } from "react";

import type { Demo } from "./foundation/demo";
import styles from "./KitchenSink.module.css";

/** Anchor id of a demo section; component names are plain words. */
function anchor(demo: Demo): string {
  return `demo-${demo.name}`;
}

/**
 * Every demo, every state: the page behind `/design`. Design review reads it, and the Playwright
 * goldens and axe run take their pictures of it. It shows the theme the page is in; flip the
 * toggle in the header to see the other (the goldens do both).
 */
export function KitchenSink({ demos }: { readonly demos: readonly Demo[] }): ReactElement {
  return (
    <div className={styles.sink}>
      <header className={styles.intro}>
        <h1>Design system</h1>
        <p>
          Every component in every state it can be pinned to. Hover, press and focus cannot be shown
          here: try them with the mouse and the keyboard.
        </p>
        <nav aria-label="Components">
          <ul className={styles.index}>
            {demos.map((demo) => (
              <li key={demo.name}>
                <a href={`#${anchor(demo)}`}>{demo.name}</a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {demos.map((demo) => (
        <section
          key={demo.name}
          id={anchor(demo)}
          aria-labelledby={`${anchor(demo)}-title`}
          data-demo={demo.name}
          className={styles.demo}
        >
          <h2 id={`${anchor(demo)}-title`}>{demo.name}</h2>
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
      ))}
    </div>
  );
}
