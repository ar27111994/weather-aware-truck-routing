import { createServer } from "node:http";
import type { Server } from "node:http";

import sirv from "sirv";

/** The port a card gets when `E2E_PORT` is not set. */
export const DEFAULT_PORT = 4201;

/**
 * The port to serve on.
 *
 * @param value - `E2E_PORT`, if set.
 * @throws {RangeError} When it is set to something that is not a port number.
 */
export function parsePort(value: string | undefined): number {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`E2E_PORT must be a port number, got "${value ?? ""}".`);
  }
  return port;
}

/**
 * What to print when the server cannot listen. A taken port gets its own wording: the point of this
 * server is that it never moves to another one.
 */
export function explainServerError(error: NodeJS.ErrnoException, port: number): string {
  return error.code === "EADDRINUSE"
    ? `Port ${String(port)} is already in use; refusing to serve on another port.`
    : `Preview server failed: ${error.message}`;
}

/**
 * Static server for a production build. Unknown paths fall back to `__spa-fallback.html`, so a
 * client-rendered route such as `/design` loads the way it does on Vercel.
 *
 * @param directory - The built `client` directory.
 */
export function createPreviewServer(directory: string): Server {
  return createServer(sirv(directory, { single: "__spa-fallback.html", etag: true, dev: false }));
}
