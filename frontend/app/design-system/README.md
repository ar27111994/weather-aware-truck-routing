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
- **Wrap every rule in `@layer components { ... }`.** The order `reset, tokens, base, components,
utilities` is declared once in `styles/layers.css`; a component rule always beats base and reset.
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
- No inline `style` attributes in product components (strict CSP): a dynamic value goes through a CSS
  custom property set from a ref or `style={{ "--x": ... }}` only where there is no alternative.
  Demos (client-rendered `/design` only) may use inline layout styles with tokens.

## TypeScript rules (strict: exactOptionalPropertyTypes, noUncheckedIndexedAccess)

- Named exports only. `readonly` props. JSDoc on every exported symbol.
- `styles["name"]` is `string | undefined`: pass it through `cx(...)`, never straight into a
  `className?: string` prop. Every component takes `className?: string` and merges it with `cx`.
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

## Demo (`<Name>.demo.tsx`)

Export `demo: Demo` (see `foundation/demo.ts`): a name, one sentence, and a list of states. The
`/design` route renders every state of every demo in light and dark for the Playwright goldens and
the axe run. Keep demos declarative (no inline functions or conditionals) so they count as covered
when the registry test renders them. Show each variant and each state that can be pinned (disabled,
invalid, loading, selected, open if it can be forced open).

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
