/**
 * Static file server for the production build, used by `pnpm preview` and by the Playwright
 * `webServer`. It replaces `sirv-cli` because that tool silently moves to another port when its
 * own is taken, and lets a `PORT` environment variable override `--port`. With several workers
 * sharing one machine either behaviour makes a test run talk to somebody else's server.
 *
 * This server binds exactly one port (`E2E_PORT`, default 4201) and exits non-zero if it is busy.
 * Unknown paths fall back to `__spa-fallback.html`, so client-rendered routes such as `/design`
 * load the same way they do on Vercel.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import sirv from "sirv";

const DEFAULT_PORT = 4201;
const HOST = "127.0.0.1";
const SERVE_DIRECTORY = fileURLToPath(new URL("../build/client", import.meta.url));

const port = Number(process.env["E2E_PORT"] ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`E2E_PORT must be a port number, got "${process.env["E2E_PORT"] ?? ""}".`);
  process.exit(1);
}

const server = createServer(
  sirv(SERVE_DIRECTORY, { single: "__spa-fallback.html", etag: true, dev: false }),
);

server.once("error", (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${String(port)} is already in use; refusing to serve on another port.`
      : `Preview server failed: ${error.message}`,
  );
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`Serving build/client at http://${HOST}:${String(port)}`);
});
