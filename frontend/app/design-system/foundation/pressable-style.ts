/**
 * The `<style>` element React Aria writes into the page the first time something pressable mounts
 * (`usePress`): its id, the attribute it puts on a pressable element, and the rule inside. A
 * `<style>` element created in the browser is blocked by the Content-Security-Policy (`style-src
 * 'self'`, D-25) and no hash can be committed for it, because the text changes with the library. So
 * the document ships the element itself: React Aria finds the id and writes nothing, and
 * `scripts/vercel_output.py inject-csp` hashes the element in the built HTML like any other inline
 * style.
 *
 * Two tests keep this honest. `pressable-style.test.tsx` checks the attribute against a rendered
 * pressable. jsdom does not run React Aria's injection, so the id is checked where it matters, in a
 * real browser: `e2e/csp.spec.ts` loads the built pages under the real policy and fails on any
 * `securitypolicyviolation`, which is what a React Aria upgrade that renames the id would cause.
 */
export const PRESSABLE_STYLE_ID = "react-aria-pressable-style";

/** The attribute React Aria puts on every pressable element, and the rule selects. */
export const PRESSABLE_ATTRIBUTE = "data-react-aria-pressable";

/** The rule: pressable elements pan and pinch, but a double tap on one does not zoom. */
export const PRESSABLE_STYLE = `@layer {\n  [${PRESSABLE_ATTRIBUTE}] {\n    touch-action: pan-x pan-y pinch-zoom;\n  }\n}`;
