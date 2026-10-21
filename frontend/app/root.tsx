import overpassLatin from "@fontsource-variable/overpass/files/overpass-latin-wght-normal.woff2?url";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement, type ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { LinkDescriptor } from "react-router";

import { createQueryClient } from "./api/queries";
import { Spinner } from "./design-system/components/Spinner";
import { PRESSABLE_STYLE, PRESSABLE_STYLE_ID } from "./design-system/foundation/pressable-style";
import { t } from "./design-system/foundation/strings";
import { THEME_INIT_SCRIPT } from "./design-system/foundation/theme-script";
import { ThemeProvider } from "./design-system/foundation/ThemeProvider";
import { AppShell } from "./shell/AppShell";
import { Page } from "./shell/Page";
import { RouteError } from "./shell/RouteError";
import "./design-system/styles/index.css";

/**
 * Preload exactly one font file: the latin Overpass the first paint needs (DESIGN.md section 14).
 * Overpass Mono first appears after a plan renders, so it loads on demand.
 */
export function links(): LinkDescriptor[] {
  return [
    {
      rel: "preload",
      href: overpassLatin,
      as: "font",
      type: "font/woff2",
      crossOrigin: "anonymous",
    },
    { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    { rel: "icon", href: "/favicon-32.png", type: "image/png", sizes: "32x32" },
    { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    { rel: "manifest", href: "/manifest.webmanifest" },
  ];
}

/**
 * The HTML document shared by every route (prerendered at build time, hydrated in the browser).
 * The inline script runs before first paint and puts the saved theme on `<html>`, so there is no
 * flash of the wrong theme; `suppressHydrationWarning` is for that one attribute. The `<style>` is
 * React Aria's own pressable rule, shipped so it never has to write one at run time (D-25).
 */
export function Layout({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#F6F6F3" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#141412" media="(prefers-color-scheme: dark)" />
        <style id={PRESSABLE_STYLE_ID}>{PRESSABLE_STYLE}</style>
        <script>{THEME_INIT_SCRIPT}</script>
        <Meta />
        <Links />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** Root route: the app shell around whichever child route matched, with the server-state cache. */
export default function App(): ReactElement {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <Outlet />
      </AppShell>
    </QueryClientProvider>
  );
}

/** Shown while a client-rendered route (such as `/design`) hydrates from the SPA fallback page. */
export function HydrateFallback(): ReactElement {
  return (
    <AppShell>
      <Page>
        <Spinner label={t("progress.state.active")} size={20} showLabel />
      </Page>
    </AppShell>
  );
}

/** Root error boundary. */
export const ErrorBoundary = RouteError;
