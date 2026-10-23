# Intent-gated hydration of the planner: a static island

Status: accepted (D-45, D-46, D-47). Applies to `/`, the planner page.

## Context

N1 caps the JavaScript of a first visit to `/` and to `/methodology` at 180,000 bytes gzipped
(D-45). The planner's code (the date, time, number and list controls, the schema library and the
query cache behind them) does not fit in that budget next to the page's shell: as one download it
makes `/` about 335 to 343 KB. Most first visits only read the page, so the planner's code is
downloaded when the visitor first reaches for it, and not before.

## Decision

- **The server draws the planner as plain markup.** The prerender draws the planner as a React root of
  its own (`renderToString`, in `planner-markup.tsx`) and the route puts that markup in
  `<div data-planner-host>` with `dangerouslySetInnerHTML`. The browser's first render of that
  element gives an empty string, so React never keeps, updates or hydrates the markup: nothing in the
  page around it can reach it.
- **A listener that is not React waits for the visitor** (`intent.ts`, plain DOM). A direct input
  asks for the planner: `pointerdown`, `touchstart`, `keydown`, `focusin`, or pointer movement over
  the panel. A timer, an idle callback, the load event, an `IntersectionObserver` or a prefetch never
  does. A shared link (a trip or a plan in the address) is a visitor who came to use the planner, so it
  loads at once. A visit that arrives by navigating inside the app has no server markup to keep: the
  planner is drawn in the page's own tree, in the same transition, with no fallback and no shift.
- **The planner takes the markup over as a root of its own** (`mountPlanner` in `PlannerApp.tsx`,
  `hydrateRoot` on the same element). The nodes are the ones the server drew, so what the visitor typed,
  where the focus is and an input method's composition stay as they were. The form is drawn once, in
  its final container, on every screen (D-47): the bottom sheet is the side panel from 1024 px by CSS
  alone, so nothing is moved, rebuilt or put in a portal. A shared link's trip fills the same form in
  place (`usePlannerForm`) in the render in which the browser's clock arrives; the panel's key is the
  address as it is on the first render, so taking the page over is not mistaken for a new address.
- **The page's router and theme are bridged in.** The planner root gets a low-level `Router` fed by
  the page's router (`planner-bridge.ts`), so the page's history stays the one history, and its own
  `ThemeProvider` on the same store. A context the shell adds later is not in the planner's root
  until `PlannerIslandTree` provides it. The server draws the planner as its own root so that the ids
  React Aria gives its fields are the ones the browser's root computes.
- **What the visitor did before the code arrived is kept** (`early-input.ts`, `early-values.ts`, D-46
  3.2). Typed text and the chosen interval are read from the markup before React draws again and put in
  the form's state. A press on a button is remembered and made once, in order, when the planner is
  alive. A submit is held back (the form has no action, so the browser would reload `/` with the
  values in the address) and runs once through the form's own handler. Edits of the date and time
  segments are held back while the busy state shows. The form says it heard the visitor at once:
  `aria-busy` and a spinner, with no layout shift.

## Why not the obvious ways

- **A lazy boundary left dehydrated until the visitor reaches for it.** This was the first design.
  React keeps a dehydrated Suspense boundary only until it is updated twice, and then draws it again
  with its fallback. With a saved theme the theme provider changes its context value right after
  hydration, and the whole planner (heading, form, panel) disappeared with no error. A theme changed
  in another tab, or any later update of the router, would do the same, however long the visitor took.
  The e2e test `a saved theme, and changes of the theme before the first input, leave the planner as
it was` failed against that design and passes against this one.
- **One eager download.** 335 to 343 KB against a budget of 180 KB.
- **Plain markup, then draw the planner again on input.** New nodes lose the typed text, the focus, an
  input method's composition and, on iOS, the on-screen keyboard.
- **A portal into the sheet on small screens.** A portal does not hydrate: it is a second drawing.

## Consequences

- Two React roots. A context the planner needs from the shell must be bridged in
  `PlannerIslandTree`; the router and the theme are. The map card's `MapView` needs the theme and the
  selection store: the theme is there, and the selection store is a module-level store.
- The server's renderer is reached only behind `import.meta.env.SSR`, so it never reaches a visitor
  (the build has no `renderToString` in `build/client/assets`).
- A visitor who leaves the page alone never downloads the planner's code: a test waits 10 s after the
  load event and asserts that no planner chunk was requested.

## Numbers

Measured in chromium on the production build, with the D-45 method (every script requested from the
start of the navigation until 2 s after the load event, gzipped), on the branch merged onto the base
at `710c0dc`:

- `/`: 178,975 bytes. `/methodology`: 179,767 bytes. The SPA fallback: 171,617 bytes. The budget is
  180,000 bytes; `/methodology` has 233 bytes to spare.
- `/` after one input (the first visit plus what one input loads, no plan asked for): 343,169
  bytes, of which 164,194 load on the input. D-46 3.5(c), as D-49 words it, caps it at exactly that
  number: on the same base the split may add only the bytes of the mechanism that D-46 3.1, 3.2, 3.3
  and D-47 require and of fixes for defects the split itself causes, every byte itemized. The
  baseline is the same page built as one eager download (`aeb1abb`, the last commit before the
  gate; its `git patch-id` equals that of `78da079`) on the same base `710c0dc`: 338,438 bytes. The
  method is `measureInitialJs` in chromium, gzip level 6, one input aimed at the planner's panel
  (`#planner`). The old cap, 336,005 bytes, was the eager size on the base before `710c0dc`; the
  base itself moved it by 2,433 bytes (D-48). The split adds 4,731 bytes. 4,688 are its own
  mechanism and structure: about 3.5 KB of code (the gate, the handoff of early input, the island
  and the router bridge) and about 1.2 KB of chunk structure that a second React root causes
  (react-dom/client becomes a shared chunk, and the shared chunk gets a longer name that every file
  importing it repeats). The other 43 are the fix that shows a plan from its top: that defect is in
  the baseline too (the same browser test fails on `aeb1abb`), so those bytes are not the split's
  and have a row of their own. The itemization is in the pull request and in the evidence of the
  card (`.planning/evidence/t7b/d48/`). The cap is a ratchet: it never rises, the check fails when
  the total is under it too, and a unit test holds the ceiling. The trade is about 159 KB less
  before the first paint for 4.7 KB (1.4 %) after the first input.
- A plan opened from its address (`/?plan=`) downloads 378,380 bytes: the planner and the results code.
- Input to interactive, from the first pointerdown on Origin to a planner that is alive, was about
  0.7 s unthrottled and about 5 s with Lighthouse's mobile profile (150 ms round trip, 1,638.4
  kbit/s, CPU four times slower) on a developer machine. The slow case is 164 KB in many small files
  over a link with a long round trip. It is the price of the split; the busy state covers it (D-46
  3.3), and fewer, larger chunks (card P1) should shorten it, which is not measured yet. The medians
  from CI and the Lighthouse table of the final head are in the pull request.
