# Haulcast design system

React Aria Components (RAC) wrapped in CSS Modules and the design tokens from
`.planning/design/` (T3). The design contract is `.planning/design/DESIGN.md`; this file only says
how the code is organised. If something you need is not specified there, pick the closest documented
token, say so in your PR description and leave a `kanban_comment` on the card.

## Layout

```
app/design-system/
  index.ts          public barrel (foundation + one `export *` line per component, alphabetical)
  tokens/           tokens.json (source) -> `pnpm tokens` -> tokens.css + tokens.ts (generated, committed)
  styles/           layers.css, reset, typography (.t-* classes), risk recipes, base, utilities
  foundation/       cx, strings (typed microcopy), risk metadata, demo types, theme store + provider
  components/<Name>/
    <Name>.tsx  <Name>.module.css  <Name>.test.tsx  <Name>.demo.tsx  index.ts
```

Import from siblings with relative paths (`../Icon`), from the system with the barrel.

## Styling rules

- **CSS Modules, tokens only.** No literal colours, sizes, radii, shadows or durations: use
  `var(--space-4)`, `var(--radius-control)`, `var(--motion-duration-fast)` and the component tokens
  (`--c-button-*`, `--c-slider-*`, ...). The few values DESIGN.md documents as literals (pattern
  geometry, spinner 900 ms) carry a comment citing the section.
- **Wrap every rule in `@layer components { ... }`.** The order `reset, tokens, base, vendor,
components, utilities` is declared once in `styles/layers.css`; a component rule always beats base
  and reset. Third-party stylesheets go in the `vendor` layer (MapLibre's:
  `features/map/maplibre.css`): unlayered, they would beat every component rule.
- **State comes from `data-*` attributes** that RAC sets (`[data-hovered]`, `[data-pressed]`,
  `[data-focus-visible]`, `[data-disabled]`, `[data-selected]`, `[data-invalid]`, `[data-pending]`).
  Variants and sizes are `data-variant` / `data-size` set by the component. Never style by position.
- **Type styles:** `composes: t-label from global;` (classes `t-display`, `t-title-lg|md|sm`,
  `t-body-lg`, `t-body`, `t-body-sm`, `t-label`, `t-caption`, `t-overline`, `t-data-lg`, `t-data`,
  `t-data-sm`, `t-plate`). Numbers in Overpass need `font-variant-numeric: tabular-nums` (`.tnum`).
- **Focus:** `:focus-visible` outline comes from base.css; ink fills and anything over the map also
  add `box-shadow: var(--focus-halo-shadow)`. Never remove an outline.
- **Targets:** mobile first. Below 1024 px every pointer target is at least `--size-target-touch`
  (44 px); from `@media (min-width: 1024px)` it may shrink to the control sizes (never below 24 px).
- **Reduced motion:** all `--motion-duration-*` tokens become 0 ms in base.css, so transitions that
  use them vanish by themselves. Keyframe animations need their own `@media (prefers-reduced-motion:
reduce)` override.
- **Forced colours:** add an `@media (forced-colors: active)` block that gives ink-filled controls
  a `ButtonText` border on `ButtonFace`, selection `Highlight`, disabled `GrayText` (DESIGN.md 8.3).
- **Risk colours** always travel with a word, a shape and a pattern: use `riskInfo()` from
  `foundation/risk` and the `.risk-fill` / `.risk-pattern` recipes in `styles/risk.css`.
- No inline styles in product components: layout and state are classes and `data-*` attributes, so
  one stylesheet holds every rule and the prerendered HTML needs no `<style>` element, which the
  policy blocks unless its hash is in `style-src`. The policy does allow style _attributes_
  (`style-src-attr 'unsafe-inline'`, D-25) because React Aria sets the position of a popover and the
  thumb of a slider through them. A dynamic value goes through a CSS custom property
  (`style={{ "--x": ... }}`) only where there is no alternative. Demos (client-rendered `/design`
  only) may use inline layout styles with tokens.

## TypeScript rules (strict: exactOptionalPropertyTypes, noUncheckedIndexedAccess)

- Named exports only. `readonly` props. JSDoc on every exported symbol.
- CSS modules are typed. `cmk` (`pnpm styles:types`, run first by `pnpm typecheck` and `pnpm lint`)
  writes a declaration for every `*.module.css` into the git-ignored `.css-modules/`, so
  `styles.button` is a `string` and `styles.buton` is a compile error. Use `styles.name` directly;
  merge with `cx(styles.name, className)` only to add a caller's class. An editor that does not
  see the types yet needs one `pnpm styles:types` (or `pnpm exec cmk --watch`).
- No `@ts-ignore`, `@ts-expect-error`, `eslint-disable` or `as` casts around a type problem.
  A cast needs a reason a reviewer would accept.
- User-facing strings come from `t()` / `tList()` / `tPlural()` (typed keys from microcopy.json);
  never type a literal sentence in a component. Components that need a caller-supplied label take it
  as a prop.
- Dates and times follow the user's locale via `Intl` (D-16, en-US means 12-hour); tests pin
  `en-US` and `en-GB`.

## Tests (Vitest + Testing Library + user-event + vitest-axe), written first

Red, green, refactor: write the failing test, watch it fail for the right reason, then implement.
Each component has tests for: rendering, every variant and size, every state it supports
(disabled, invalid, loading, selected, read-only...), keyboard operation (user-event), ARIA
attributes and accessible names, controlled and uncontrolled use, className merging, and an axe run
(`await expectNoAxeViolations(container)` from `test/axe`) over all variants. Use `installMatchMedia`
from `test/match-media` when a test needs `matchMedia`. Do not mock React Aria; render the real thing.
Coverage for the component's own files must be 100% (lines, branches, functions, statements); a
branch you cannot reach is dead code: delete it.

Shared helpers live in `frontend/test/`: `states.ts` asserts that hover, press and keyboard focus reach
the `data-*` attributes the styles read (`carrier` is the element that holds them when that is not
the one the user points at: a radio's label, a slider's thumb); `controlled.tsx` runs a component
under a parent that owns its value; `voice.ts` holds the voice rules. A test that logs a console
error or warning fails unless it says so with `allowConsole` (`test/console-guard.ts`), so React and
React Router cannot print a problem nobody reads. A failing property test prints its seed:
`FC_SEED=<seed> pnpm test` replays it.

## Demo (`<Name>.demo.tsx`)

Export `demo: Demo` (see `foundation/demo.ts`): a name, one sentence, and a list of states. The
`/design` route renders every state of every demo in light and dark for the Playwright goldens and
the axe run. Keep demos declarative (no inline functions or conditionals) so they count as covered
when the registry test renders them. Show each variant and each state that can be pinned (disabled,
invalid, loading, selected, open if it can be forced open).

A demo's description and the caption of each state are documentation of the specimen, so they live in
the demo file and are not microcopy; they follow the voice rules all the same
(`demo-registry.test.tsx` checks them). The chrome of the page itself (title, introduction,
navigation label) is microcopy: `design.*` in `foundation/microcopy.json`.

## Checks before you hand over

```
pnpm exec vitest run app/design-system/components/<Name> --coverage \
  --coverage.include='app/design-system/components/<Name>/**'
pnpm exec eslint app/design-system/components/<Name>
pnpm exec prettier --check app/design-system/components/<Name>
pnpm typecheck        # other folders may still be in progress; only your files matter
```

Shared pieces you can use: `Icon`, `VisuallyHidden`, `Spinner`, `Button`, `cx`, `t`, `riskInfo`,
`tokens` (resolved literals per theme, for JS that cannot read CSS variables).

## App shell, theme and routes (T6a)

```
app/shell/        AppShell (skip link, header, one main, footer), AppHeader, AppFooter, Page,
                  RouteError (error boundary + not-found page), page-meta (per-route meta), route-handle
app/root.tsx      document Layout (inline theme script, font preload), App, HydrateFallback, ErrorBoundary
app/routes/       home, methodology (placeholders), design (kitchen sink), not-found (the `*` route)
```

- **Theme (R13).** `foundation/theme*.ts` holds the choice (`light | dark | system`, saved as
  `hc-theme`); `ThemeProvider` / `useTheme()` expose `theme`, `resolvedTheme` (for the map style) and
  `setTheme`. An inline script in `<head>` (`foundation/theme-script.ts`) sets `<html data-theme>`
  before first paint. No hash of it is recorded anywhere: the Vercel build hashes every inline
  script of the built HTML into the CSP (`scripts/vercel_output.py`), and `e2e/csp.spec.ts` loads
  the pages in Chromium, Firefox and WebKit under that policy. `system` is resolved by CSS
  (`prefers-color-scheme` in `tokens.css`), so it needs no JavaScript.
- **Content-Security-Policy (D-25).** The prerendered HTML is served with `style-src 'self'`: an inline
  `<style>` element is blocked unless `scripts/vercel_output.py` has put its hash in the policy at
  build time. Style attributes are allowed (`style-src-attr 'unsafe-inline'`): React Aria writes
  them for the position of a popover and the thumb of a slider. Anything that can appear in `/` or
  `/methodology` is still styled by classes and `data-*` attributes (`VisuallyHidden`, `Layout`,
  `Skeleton`, `Legend` do this; tests assert no `style` attribute), so the page does not lean on
  that allowance.
- **Route handle.** A route can export `handle = { skipLink: { href, label }, footer: false }`.
  The shell merges the handles of the matched routes: the planner points the skip link at its own
  section and draws the footer inside its panel; every other page gets "Skip to main content" and
  the footer.
- **Route meta.** Routes export `meta = () => pageMeta({ title, description, path })`. It adds the
  description, canonical link, Open Graph and Twitter tags. Canonical and image URLs need an
  origin: set `VITE_SITE_URL` at build time, otherwise those tags are left out rather than guessed.
- **`/design`.** `routes/design.tsx` finds every `components/*/*.demo.tsx` with `import.meta.glob`,
  so adding a component adds its specimens to the page, the Playwright goldens and the axe run.
  It is `noindex` and must stay out of the sitemap.

## Adding a component

1. Folder `components/<Name>/` with `<Name>.tsx`, `<Name>.module.css`, `<Name>.test.tsx`,
   `<Name>.demo.tsx` (exports `demo`), `index.ts`.
2. Add `export * from "./components/<Name>";` to `index.ts`, in alphabetical order (a test checks).
3. Tests first, 100% coverage of the folder, `expectNoAxeViolations` over every variant.
4. A demo state for every variant and every state that can be pinned.

Layout primitives (`Stack`, `Inline`, `Grid`) share one folder, `components/Layout/`, because they
share one stylesheet and one set of gap rules.

## Timeline slider

`Slider` is built on the React Aria hooks (`useSlider`, `useSliderThumb`, `react-stately`'s
`useSliderState`) and not on the Components wrapper, because the wrapper formats `aria-valuetext`
as a number and the timeline must read "Tue 2:00 PM, +6 hours" aloud. `TimelineSlider` takes the
departure instant, an optional IANA `timeZone` and `locale` (en-US is a 12-hour clock, D-16), and
renders the hour ticks, the `+6 h` labels (the last one hangs inward) and the weekday at every local
midnight. Arrows move 1 hour, Page Up and Page Down 6, Home and End jump to the ends. The map card
adds Play, the field switch and `TimelineReadout`.
