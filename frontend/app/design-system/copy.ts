import microcopy from "./microcopy.json";

/**
 * Every Haulcast UI string (en-US), typed straight from `microcopy.json`. Components take their
 * default copy from here so wording lives in one reviewed file; tests assert against these keys,
 * never against duplicated literals.
 */
export const copy = microcopy;

/** Values accepted by {@link format}: the `{name}` placeholders of a microcopy template. */
export type CopyValues = Readonly<Record<string, string | number>>;

/**
 * Fills the `{name}` placeholders of a microcopy template. A placeholder without a value is left
 * visible (`{name}`) so a missing argument shows up in review instead of rendering a blank.
 */
export function format(template: string, values: CopyValues): string {
  return template.replace(/\{(\w+)\}/g, (placeholder: string, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}
