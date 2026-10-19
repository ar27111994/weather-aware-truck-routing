import microcopy from "./microcopy.json";

type Copy = typeof microcopy;

type Join<Prefix extends string, Key extends string> = Prefix extends "" ? Key : `${Prefix}.${Key}`;

/** Dotted paths to string leaves (`rec.badge`), skipping `$comment`-style metadata keys. */
type LeafPaths<Node, Prefix extends string = ""> = {
  [Key in keyof Node & string]: Key extends `$${string}`
    ? never
    : Node[Key] extends string
      ? Join<Prefix, Key>
      : Node[Key] extends readonly unknown[]
        ? never
        : Node[Key] extends object
          ? LeafPaths<Node[Key], Join<Prefix, Key>>
          : never;
}[keyof Node & string];

/** Dotted paths to string-array leaves (`empty.steps`). */
type ListPaths<Node, Prefix extends string = ""> = {
  [Key in keyof Node & string]: Key extends `$${string}`
    ? never
    : Node[Key] extends readonly string[]
      ? Join<Prefix, Key>
      : Node[Key] extends string
        ? never
        : Node[Key] extends object
          ? ListPaths<Node[Key], Join<Prefix, Key>>
          : never;
}[keyof Node & string];

/** Every user-facing string key in `microcopy.json`. */
export type StringKey = LeafPaths<Copy>;

/** Keys of string lists, such as the three "how it works" steps. */
export type ListKey = ListPaths<Copy>;

/** Base of a `_one`/`_other` pair: `status.planReady` for `status.planReady_one`. */
export type PluralKey = StringKey extends infer Key
  ? Key extends `${infer Base}_one`
    ? Base
    : never
  : never;

/** Values for `{placeholder}` slots. */
export type StringParams = Readonly<Record<string, string | number>>;

const PLURAL_RULES = new Intl.PluralRules("en-US");
const PLACEHOLDER = /\{(\w+)\}/g;

function find(key: string): unknown {
  let node: unknown = microcopy;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) {
      return undefined;
    }
    node = Reflect.get(node, part);
  }
  return node;
}

/**
 * True when `key` names a string in microcopy.json. Use it to narrow keys that are built at
 * runtime (an API error code becomes `error.${code}.title`) before calling {@link t}.
 */
export function isStringKey(key: string): key is StringKey {
  return typeof find(key) === "string";
}

/**
 * Returns a string from `microcopy.json` with its `{placeholders}` filled in.
 *
 * @param key - Dotted key, checked at compile time.
 * @param params - Values for the placeholders the string contains.
 * @throws {Error} If a placeholder has no value (a developer error, never user input), or if the
 *   key is not a string (only reachable by casting around the type).
 */
export function t(key: StringKey, params: StringParams = {}): string {
  const template = find(key);
  if (typeof template !== "string") {
    throw new Error(`Unknown microcopy string "${key}".`);
  }
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Microcopy key "${key}" needs a value for {${name}}.`);
    }
    return String(value);
  });
}

/**
 * Picks the `_one` or `_other` form for a count (English plural rules) and fills it in. The count is
 * also available to the string as `{count}`.
 */
export function tPlural(base: PluralKey, count: number, params: StringParams = {}): string {
  const form = PLURAL_RULES.select(count) === "one" ? "one" : "other";
  return t(`${base}_${form}`, { count, ...params });
}

/** Returns a list of strings, e.g. the "how it works" steps. */
export function tList(key: ListKey): readonly string[] {
  const list = find(key);
  if (!Array.isArray(list) || !list.every((item): item is string => typeof item === "string")) {
    throw new Error(`Unknown microcopy list "${key}".`);
  }
  return list;
}
