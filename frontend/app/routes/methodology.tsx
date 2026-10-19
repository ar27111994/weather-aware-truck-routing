import type { ReactElement } from "react";
import type { MetaDescriptor } from "react-router";

export function meta(): MetaDescriptor[] {
  return [
    { title: "Methodology — Haulcast" },
    {
      name: "description",
      content: "How Haulcast scores weather risk along a truck route and ranks the options.",
    },
  ];
}

/** Placeholder methodology page: the full write-up arrives with the docs card. */
export default function Methodology(): ReactElement {
  return (
    <main>
      <h1>Methodology</h1>
      <p>How Haulcast scores weather risk is documented here soon.</p>
    </main>
  );
}
