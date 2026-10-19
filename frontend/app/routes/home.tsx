import type { ReactElement } from "react";
import type { MetaDescriptor } from "react-router";

export function meta(): MetaDescriptor[] {
  return [
    { title: "Haulcast — Weather-aware truck routing" },
    {
      name: "description",
      content: "Pick the safest truck route from weather, load weight and travel time.",
    },
  ];
}

/** Placeholder landing page: the planner UI replaces it in the frontend feature cards. */
export default function Home(): ReactElement {
  return (
    <main>
      <h1>Haulcast</h1>
      <p>Weather-aware truck routing is on its way.</p>
    </main>
  );
}
