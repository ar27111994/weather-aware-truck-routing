import { vi } from "vitest";

/** Handle returned by {@link installMatchMedia}. */
export interface MatchMediaController {
  /** Changes whether a media query matches and notifies every listener registered for it. */
  readonly setMatches: (query: string, matches: boolean) => void;
  /** Change listeners registered for a query right now, across every list made for it. */
  readonly listenerCount: (query: string) => number;
  /** How many times a listener was registered for a query, removed ones included. */
  readonly subscribeCount: (query: string) => number;
  /** How many `MediaQueryList` objects `window.matchMedia` made for a query. */
  readonly listCount: (query: string) => number;
}

/** The `change` event of a media query list: the two fields code under test can read. */
class FakeChangeEvent extends Event implements MediaQueryListEvent {
  readonly matches: boolean;
  readonly media: string;

  constructor(matches: boolean, media: string) {
    super("change");
    this.matches = matches;
    this.media = media;
  }
}

/**
 * The part of `MediaQueryList` that the app reads: `matches`, `media` and `change` listeners. The
 * listener bookkeeping is the platform's own (`EventTarget`); this class only counts what goes in
 * and out, so a test can prove a hook subscribes once and lets go on unmount.
 */
class FakeMediaQueryList extends EventTarget {
  readonly media: string;
  readonly #read: () => boolean;
  readonly #listeners = new Set<EventListenerOrEventListenerObject>();
  subscriptions = 0;

  constructor(media: string, read: () => boolean) {
    super();
    this.media = media;
    this.#read = read;
  }

  get matches(): boolean {
    return this.#read();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (type === "change" && callback !== null) {
      this.#listeners.add(callback);
      this.subscriptions += 1;
    }
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (type === "change" && callback !== null) {
      this.#listeners.delete(callback);
    }
    super.removeEventListener(type, callback, options);
  }
}

/**
 * jsdom does not implement `window.matchMedia`. This installs a controllable stand-in (removed
 * automatically after each test because the Vitest config sets `unstubGlobals`).
 *
 * @param initial - Media query strings mapped to whether they match; anything else does not.
 */
export function installMatchMedia(
  initial: Readonly<Record<string, boolean>> = {},
): MatchMediaController {
  const state = new Map<string, boolean>(Object.entries(initial));
  const lists = new Map<string, FakeMediaQueryList[]>();

  const listsFor = (query: string): FakeMediaQueryList[] => lists.get(query) ?? [];

  vi.stubGlobal("matchMedia", (query: string): FakeMediaQueryList => {
    const list = new FakeMediaQueryList(query, () => state.get(query) ?? false);
    lists.set(query, [...listsFor(query), list]);
    return list;
  });

  return {
    setMatches(query, matches) {
      state.set(query, matches);
      for (const list of listsFor(query)) {
        list.dispatchEvent(new FakeChangeEvent(matches, query));
      }
    },
    listenerCount: (query) => listsFor(query).reduce((sum, list) => sum + list.listenerCount, 0),
    subscribeCount: (query) => listsFor(query).reduce((sum, list) => sum + list.subscriptions, 0),
    listCount: (query) => listsFor(query).length,
  };
}
