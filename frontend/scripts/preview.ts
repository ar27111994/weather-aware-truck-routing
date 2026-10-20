/**
 * Static file server for the production build, used by `pnpm preview` and by the Playwright
 * `webServer`. It replaces `sirv-cli` because that tool silently moves to another port when its
 * own is taken, and lets a `PORT` environment variable override `--port`. With several workers
 * sharing one machine either behaviour makes a test run talk to somebody else's server.
 *
 * This server binds exactly one port (`E2E_PORT`, default 4201) and exits non-zero if it is busy.
 *
 * Process wrapper only: the port rules, the error wording and the server itself are in
 * `preview/server.ts`, which the unit tests run for real on a free port.
 */
import { fileURLToPath } from "node:url";

import { createPreviewServer, explainServerError, parsePort } from "./preview/server.ts";

const HOST = "127.0.0.1";
const SERVE_DIRECTORY = fileURLToPath(new URL("../build/client", import.meta.url));

let port: number;
try {
  port = parsePort(process.env["E2E_PORT"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const server = createPreviewServer(SERVE_DIRECTORY);

server.once("error", (error: NodeJS.ErrnoException) => {
  console.error(explainServerError(error, port));
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`Serving build/client at http://${HOST}:${String(port)}`);
});
