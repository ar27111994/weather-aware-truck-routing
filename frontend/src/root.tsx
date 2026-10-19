import type { ReactElement, ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

/** The HTML document shell shared by every route (prerendered at build time, hydrated in the browser). */
export function Layout({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** Root route: renders whichever child route matched. */
export default function App(): ReactElement {
  return <Outlet />;
}
