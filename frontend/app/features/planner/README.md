# The planner feature

`app/features/planner` is the trip form, the page layout and the planner session; `app/features/results`
is what a plan looks like. `/` is the planner page.

**How the planner reaches the visitor.** The prerendered `/` has the whole planner in it as plain markup,
drawn by the server as a React root of its own (`planner-markup.tsx`) and kept by the page as an element
that no update of the page reaches (`PlannerIsland.tsx`). The planner's code is a separate download that
starts when the visitor first gives the page an input (`intent.ts`), and it takes that same markup over as
a root of its own (`mountPlanner` in `PlannerApp.tsx`), with the page's router and theme bridged in
(`planner-bridge.ts`). Typed text, presses and a submit made before the code arrives are kept and made once
(`early-input.ts`, `early-values.ts`). Why it is built this way, what it replaced and what it costs:
[the ADR](../../../../docs/adr/intent-gated-hydration-of-the-planner.md).

**Adding to the planner.** What the planner needs from the shell (a context, a store with a provider) has
to be provided in `PlannerIslandTree`, because the planner is a React root of its own. Anything that opens
`/` in a test and waits for the page to come alive has to give it an input first (`wakePlanner` in
`e2e/support/planner.ts`); no test switch loads the planner's code.
