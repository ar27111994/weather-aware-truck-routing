import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";

import { createQueryClient } from "../../api/queries";
import { PlannerPage } from "./PlannerPage";

/**
 * The planner with the server-state cache it reads from. Only the planner talks to the API, so the
 * cache lives here and not in the root route: the shell is downloaded by every page, and the cache
 * library with the schema library behind it is not something the methodology page needs (N1).
 */
export default function PlannerApp(): ReactElement {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <PlannerPage />
    </QueryClientProvider>
  );
}
