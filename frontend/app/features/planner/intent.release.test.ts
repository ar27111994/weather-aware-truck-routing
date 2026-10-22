import { createIntentGate } from "./intent";
import { describe, expect, it } from "vitest";

// What the gate remembers is for the planner's code and for nobody else: once the planner is alive and
// has been told, the record must not linger (the planner may be left and visited again).
describe("IntentGate.release", () => {
  it("forgets the presses and the submit it was keeping for the planner", () => {
    document.body.innerHTML =
      '<div data-planner-island><form><button type="button">Swap</button></form></div>';
    const gate = createIntentGate(document);
    const form = document.querySelector("form");
    document.querySelector("button")?.click();
    form?.requestSubmit();

    gate.release();

    expect(gate.take()).toEqual({ activations: [], submitted: false });
    gate.dispose();
    document.body.innerHTML = "";
  });
});
