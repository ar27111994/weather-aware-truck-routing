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
  loads at once. A visit that arrives by navigating inside the app has no server markup in its page:
  it reads the prerender's drawing from the prerendered page (`planner-shell.ts`, one request for
  `/`), draws it as the same static island and starts the planner's code at once, because arriving
  is the input. The router keeps the old page until the drawing is read (reading it suspends the
  transition that the router moves between pages in, and nothing below the route is a boundary
  that could show a fallback), so the page is never empty, and nothing shifts when the planner takes
  the drawing over (R4-01).
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
- **The markup is drawn in its own styles, which are the page's** (`scripts/chunking/shell-styles.ts`,
  R4-01). Vite ties the styles of what the planner draws to the planner's lazy chunk, and until the
  chunk loaded 61 of the 74 classes of the markup had no rule: the first paint of `/` was a form
  without its panel, grid and fields (the busy marker showing), and the first input drew everything
  again with a jump. On a client navigation the shell was drawn the same way, ahead of its styles:
  0.5 to 1.0 of layout shift in the trace of the first CI run of the e2e (run 39950114313). The build
  now writes the styles of the planner's static code (not the map's, not the results': those
  arrive with the code that needs them) that no page already has as one file, `planner-shell`,
  and the route of `/` lists it. React Router then links it in the prerendered page and holds a
  client navigation until it has arrived, as it does for every route's styles. Only `/` pays for it:
  36.3 kB raw (5.8 kB gzipped) in one request. The same rules come again, in the files of the
  planner's code, on the first input; the rules are the same, so nothing changes when they do.
- **A scroll that comes with the focus does not take away what the visitor typed**
  (`ComboBoxPopover`, R4-01). With the styles drawn at first paint the sheet's content is a scroll
  container from the first frame. A tap on a control scrolls it, and a field that takes focus later
  scrolls it back; the `scroll` event of that scroll can arrive after the first letters have opened
  the list. React Aria closes the list of a combo box from a scroll listener, and its close is a
  commit, which takes back the text. A fast first input (`fill()` in `e2e/early-input.spec.ts`) lost
  its text this way on Firefox and the Pixel 7 (the order of events is in CI run 40032953668). So a
  close that arrives inside a scroll event is refused; the list is open only while the input has
  focus. Escape, a blur, a pick and a new query close it as before. WebKit showed a second case
  (the iPhone 14): a script that focuses a field that is scrolled out of the sheet's content does
  not bring it into view there, and the list opened above the screen. So the input scrolls itself
  into view (`nearest`) when it takes focus, which moves nothing for a field that is in view.
- **A list that changes size does not change side** (`ComboBoxPopover`, `listSideFor`, R4-01). The
  list of a combo box shows one row while a search runs and the results after. React Aria moves a
  list that no longer fits to the other side of the input, inside the callback of the
  ResizeObserver that watches it, so the list grows within the frame that reported its size and
  WebKit reports "ResizeObserver loop completed with undelivered notifications". The iPhone 14 run
  of `e2e/early-input.spec.ts` showed it: the scroll of the early tap left the To field 95 px above
  the bottom of the screen, one row fits below it and the results do not, and the list flipped (the
  tracer of CI run 40053253082: the callback changed the box from 75 to 99.8 px and rewrote
  `max-height: 75px; top: 577px` to `max-height: 506px; bottom: 146px`). No other engine and no
  other position reported it. So the side is chosen from the room around the input, when the list
  opens and when the window or the visual viewport changes size: below, unless there are fewer
  than 200 px below and more room above. The popover is told not to flip. What this gives up: a
  field that is low on the screen opens its list above it even when one row would fit below.

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
  card (`.planning/evidence/t7b/d48/`). The cap is a ratchet: it rises only by itemized fixes of defects (D-51), the check fails when
  the total is under it too, and a unit test holds the ceiling. P1 lowered it to 332,625 bytes
  (107 files became 74: `demo-blind-chunks.md`). The review fixes of the pull request that
  followed raised it to 336,371 bytes (73 files): 3,746 bytes in rows that each name a review
  finding (D-51); the rows are in `.planning/evidence/r4f/d49-itemization.md` and in the pull
  request. The trade is about 159 KB less
  before the first paint for 4.7 KB (1.4 %) after the first input.
- A plan opened from its address (`/?plan=`) downloads 378,380 bytes: the planner and the results code.
- Input to interactive, from the first pointerdown on Origin to a planner that is alive, was about
  0.7 s unthrottled and about 5 s with Lighthouse's mobile profile (150 ms round trip, 1,638.4
  kbit/s, CPU four times slower) on a developer machine. The slow case is 164 KB in many small files
  over a link with a long round trip. It is the price of the split; the busy state covers it (D-46
  3.3), and fewer, larger chunks should shorten it: P1 (D-48, `demo-blind-chunks.md`) took `/` after
  one input from 107 files to 74. The medians from CI and the Lighthouse table of the final head of
  this change are in its pull request (#31); the medians on the P1 head are in the P1 pull request.
