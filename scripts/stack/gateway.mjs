#!/usr/bin/env node
/**
 * The front door of the local stack (docs/STACK.md): the production build of the frontend, served by
 * the preview module the e2e suite already uses, with `/api` proxied to Django. It is what Vercel
 * does for this repository: static files and the SPA fallback for everything else, the API behind
 * the same origin.
 *
 * usage: E2E_PORT=4210 STACK_DJANGO_PORT=8110 node scripts/stack/gateway.mjs [--dir <build/client>]
 *          [--host 127.0.0.1]
 *
 * The gateway is `pnpm preview` plus the proxy, so it takes its port the way the preview does:
 * `E2E_PORT` (default 4201), exactly that one, never another (a busy port is an error). The port of
 * Django is `STACK_DJANGO_PORT`, with no default: a gateway that guessed it could talk to somebody
 * else's server.
 *
 * What the proxy promises, because the backend depends on it:
 * - `Host` goes through unchanged. Django compares the `Origin` of a POST with the host of the
 *   request and validates `ALLOWED_HOSTS` against it; a rewritten host answers 400 or 403.
 * - `x-forwarded-for` goes through exactly as the client sent it, and the gateway never adds one.
 *   The backend counts a client by that header (`CLIENT_IP_HEADER`) and only when it holds exactly
 *   one IP, so an appended hop would put every client into the shared `unknown` bucket.
 * - Hop-by-hop headers (RFC 9110, section 7.6.1) stop here, in both directions; every other header
 *   and every duplicate header line is forwarded.
 * - Only `/api` and `/api/...` reach Django. The decision is made on the path of the request
 *   target as written, without normalising it, so no spelling of a path outside `/api` can reach
 *   the API through the gateway.
 *
 * Not a mock: a Django that is not listening gives `502`, never a canned answer.
 */
import { createServer, request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createPreviewServer,
  explainServerError,
  parsePort,
} from "../../frontend/scripts/preview/server.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DIRECTORY = fileURLToPath(new URL("../../frontend/build/client", import.meta.url));
const SPA_FALLBACK = "__spa-fallback.html";
/** Django listens on loopback only (scripts/stack.sh starts waitress on 127.0.0.1). */
const UPSTREAM_HOST = "127.0.0.1";
const USAGE = "usage: gateway.mjs [--dir <build/client>] [--host <address>]";

/** Headers that belong to one connection, not to the message (RFC 9110, section 7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Whether a request target belongs to the API: its path is `/api` or starts with `/api/`.
 *
 * @param {string} target - The request target as written in the request line.
 * @returns {boolean}
 */
export function isApiPath(target) {
  const query = target.indexOf("?");
  const pathname = query === -1 ? target : target.slice(0, query);
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * The headers of a message minus the hop-by-hop ones: the fixed set and every header that the
 * `Connection` header names.
 *
 * @param {Record<string, string[]>} headers - `headersDistinct` of the message: lower-case names,
 *   every line of a repeated header kept apart.
 * @returns {Record<string, string | string[]>} A header with one line is a string (Node's client
 *   wants `Host` as one), a repeated header stays an array of its lines.
 */
export function forwardableHeaders(headers) {
  const named = new Set(
    (headers.connection ?? []).flatMap((value) =>
      value.split(",").map((token) => token.trim().toLowerCase()),
    ),
  );
  const kept = {};
  for (const [name, lines] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && !named.has(name)) {
      kept[name] = lines.length === 1 ? lines[0] : lines;
    }
  }
  return kept;
}

/**
 * Answers `502` with a problem document, or, when the answer has already started, cuts the
 * connection: a second status line would corrupt it.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} host - The address Django was supposed to answer on.
 * @param {number} port
 */
export function replyBadGateway(res, host, port) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({
    type: "about:blank",
    title: "Bad Gateway",
    status: 502,
    detail: `The API did not answer on ${host}:${String(port)}. Is the stack up?`,
  });
  res.writeHead(502, {
    "content-type": "application/problem+json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Sends one request to Django and streams the answer back; the status and headers are Django's. */
function proxy(req, res, upstreamPort) {
  const upstream = httpRequest({
    host: UPSTREAM_HOST,
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers: forwardableHeaders(req.headersDistinct),
    // One connection per request: a kept-alive socket that waitress has closed in the meantime
    // would fail the next request for no reason.
    agent: false,
  });
  upstream.once("response", (reply) => {
    res.writeHead(reply.statusCode, reply.statusMessage, forwardableHeaders(reply.headersDistinct));
    // Destroys the client's response if Django's answer breaks off, so the client sees the break.
    pipeline(reply, res, () => {});
  });
  upstream.once("error", () => replyBadGateway(res, UPSTREAM_HOST, upstreamPort));
  // The client left before the answer was complete: stop asking Django.
  res.once("close", () => {
    if (!res.writableFinished) {
      upstream.destroy();
    }
  });
  req.pipe(upstream);
}

/**
 * The gateway server (not yet listening).
 *
 * @param {{ directory: string, upstreamPort: number }} options - The `client` directory of the
 *   production build, and the port Django listens on.
 * @returns {import("node:http").Server}
 */
export function createGateway({ directory, upstreamPort }) {
  // The preview server is never bound to a port: its request handler is borrowed, so the static
  // files and the SPA fallback are exactly the ones `pnpm preview` serves.
  const files = createPreviewServer(directory);
  return createServer((req, res) => {
    if (isApiPath(req.url)) {
      proxy(req, res, upstreamPort);
    } else {
      files.emit("request", req, res);
    }
  });
}

/**
 * The command line: `--dir` and `--host`, each with a value.
 *
 * @param {string[]} argv
 * @returns {{ dir: string, host: string }}
 */
export function parseArgs(argv) {
  const options = { dir: DEFAULT_DIRECTORY, host: DEFAULT_HOST };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--dir" && flag !== "--host") || value === undefined) {
      throw new Error(USAGE);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

/** The port of Django, validated with the preview's port rules; there is no default. */
function readUpstreamPort(env) {
  try {
    return parsePort(env.STACK_DJANGO_PORT ?? "");
  } catch (error) {
    throw new RangeError(
      `STACK_DJANGO_PORT must be a port number, got "${String(env.STACK_DJANGO_PORT)}".`,
      { cause: error },
    );
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * Starts the gateway.
 *
 * @param {string[]} argv - The command line without the interpreter and the script.
 * @param {Record<string, string | undefined>} [env] - `E2E_PORT` and `STACK_DJANGO_PORT`.
 * @param {(line: string) => void} [log] - Receives the ready line.
 * @returns {Promise<import("node:http").Server>} The listening server.
 * @throws {Error} When an option or port is wrong, there is no build to serve, or the port is
 *   taken (the gateway never moves to another one).
 */
export async function main(argv, env = process.env, log = console.log) {
  const { dir, host } = parseArgs(argv);
  const port = parsePort(env.E2E_PORT);
  const upstreamPort = readUpstreamPort(env);
  if (!existsSync(path.join(dir, SPA_FALLBACK))) {
    throw new Error(
      `${dir} is not a frontend production build (no ${SPA_FALLBACK}): run pnpm build.`,
    );
  }
  const server = createGateway({ directory: dir, upstreamPort });
  try {
    await listen(server, port, host);
  } catch (error) {
    throw new Error(explainServerError(error, port), { cause: error });
  }
  log(
    `Serving ${dir} at http://${host}:${String(port)}; /api goes to http://${UPSTREAM_HOST}:${String(upstreamPort)}`,
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
