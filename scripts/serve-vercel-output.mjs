#!/usr/bin/env node
/**
 * Serves a `vercel build` output (`.vercel/output`, Build Output API v3) the way Vercel serves it, for
 * Lighthouse CI: the routes of `config.json` (header rules, filesystem handler, rewrites, error
 * pages) are evaluated on every request and text assets are brotli/gzip-compressed, so the
 * measurement sees the headers, the SPA fallback and the transfer sizes of a deployment instead of
 * those of a compression-less preview server.
 *
 * usage: node scripts/serve-vercel-output.mjs [--dir .vercel/output] [--host 127.0.0.1] [--port 4173]
 *
 * Scope, stated honestly: static files only. A request that resolves to the Python function answers
 * 501 (measure a deployed preview for API behaviour). Compression levels are assumptions (Vercel does
 * not publish its own), and the server speaks HTTP/1.1 on loopback, not HTTP/2 through a CDN. Route
 * features this interpreter does not implement make `loadOutput` fail instead of serving something
 * different from production.
 */
import { createServer, STATUS_CODES } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";

const DEFAULTS = Object.freeze({ dir: ".vercel/output", host: "127.0.0.1", port: 4173 });
const MIN_COMPRESSIBLE_BYTES = 1024;
const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const ENCODING_PREFERENCE = ["br", "gzip"];

const ROUTE_FIELDS = new Set(["src", "dest", "headers", "continue", "check", "status"]);
const HANDLE_PHASES = new Set(["filesystem", "error", "miss"]);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".wasm", "application/wasm"],
]);
const COMPRESSIBLE_TYPES = new Set([
  "application/json",
  "application/manifest+json",
  "application/xml",
  "application/wasm",
  "image/svg+xml",
  "image/x-icon",
  "font/ttf",
  "font/otf",
]);

/**
 * @typedef {{ urlPath: string, type: string, body: Buffer, encodings: Record<string, Buffer> }} StaticFile
 * @typedef {{ pattern: RegExp, dest?: string, headers: Record<string, string>, continue: boolean,
 *   check: boolean, status?: number }} Route
 * @typedef {{ none: Route[], filesystem: Route[], miss: Route[], error: Route[] }} Phases
 * @typedef {{ files: Map<string, StaticFile>, functions: Set<string>, phases: Phases }} Output
 * @typedef {{ status: number, headers: Record<string, string>, file: StaticFile | null,
 *   functionPath: string | null }} Resolution
 */

/**
 * Parses the command line.
 * @param {string[]} argv
 * @returns {{ dir: string, host: string, port: number }}
 */
export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag !== "--dir" && flag !== "--host" && flag !== "--port") {
      throw new Error(`unknown option ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--port") {
      if (!/^\d+$/.test(value) || Number(value) > 65535) {
        throw new Error(`invalid port ${value}`);
      }
      options.port = Number(value);
    } else {
      options[flag.slice(2)] = value;
    }
  }
  return options;
}

/** @param {string} filePath */
function contentTypeOf(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

/** @param {string} type */
function isCompressible(type) {
  const bare = type.split(";")[0];
  return bare.startsWith("text/") || COMPRESSIBLE_TYPES.has(bare);
}

/**
 * Precomputes the compressed variants once at startup, so no request pays compression time (which
 * would pollute the first Lighthouse run's server response time).
 * @param {Buffer} body
 * @param {string} type
 * @returns {Record<string, Buffer>}
 */
function compress(body, type) {
  if (!isCompressible(type) || body.length < MIN_COMPRESSIBLE_BYTES) {
    return {};
  }
  const candidates = {
    br: brotliCompressSync(body, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: 11,
        [zlib.BROTLI_PARAM_SIZE_HINT]: body.length,
        [zlib.BROTLI_PARAM_MODE]: type.startsWith("text/")
          ? zlib.BROTLI_MODE_TEXT
          : zlib.BROTLI_MODE_GENERIC,
      },
    }),
    gzip: gzipSync(body, { level: 9 }),
  };
  return Object.fromEntries(
    Object.entries(candidates).filter(([, variant]) => variant.length < body.length),
  );
}

/**
 * @param {string} dir
 * @returns {Promise<Map<string, StaticFile>>}
 */
async function indexStatic(dir) {
  const files = new Map();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const absolute = path.join(entry.parentPath, entry.name);
    const urlPath = `/${path.relative(dir, absolute).split(path.sep).join("/")}`;
    const type = contentTypeOf(absolute);
    const body = await readFile(absolute);
    files.set(urlPath, { urlPath, type, body, encodings: compress(body, type) });
  }
  return files;
}

/**
 * Function entrypoints (`functions/api/index.func` serves `/api/index`).
 * @param {string} dir
 * @returns {Promise<Set<string>>}
 */
async function indexFunctions(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".func"))
      .map((entry) => {
        const relative = path.relative(dir, path.join(entry.parentPath, entry.name));
        return `/${relative.split(path.sep).join("/").slice(0, -".func".length)}`;
      }),
  );
}

/**
 * Splits `config.json` routes into the phases delimited by `{ handle }` entries and compiles them.
 * @param {unknown[]} routes
 * @returns {Phases}
 */
function compileRoutes(routes) {
  /** @type {Phases} */
  const phases = { none: [], filesystem: [], miss: [], error: [] };
  let phase = "none";
  for (const entry of routes) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("unsupported route: not an object");
    }
    if ("handle" in entry) {
      if (typeof entry.handle !== "string" || !HANDLE_PHASES.has(entry.handle)) {
        throw new Error(`unsupported handle phase ${JSON.stringify(entry.handle)}`);
      }
      phase = entry.handle;
      continue;
    }
    const unsupported = Object.keys(entry).filter((field) => !ROUTE_FIELDS.has(field));
    if (unsupported.length > 0) {
      throw new Error(
        `unsupported route field(s) ${unsupported.join(", ")} in ${JSON.stringify(entry)}`,
      );
    }
    if (typeof entry.src !== "string") {
      throw new Error(`unsupported route without src: ${JSON.stringify(entry)}`);
    }
    phases[phase].push({
      pattern: new RegExp(entry.src),
      dest: entry.dest,
      headers: Object.fromEntries(
        Object.entries(entry.headers ?? {}).map(([name, value]) => [
          name.toLowerCase(),
          String(value),
        ]),
      ),
      continue: entry.continue === true,
      check: entry.check === true,
      status: entry.status,
    });
  }
  return phases;
}

/**
 * @param {string} file path of config.json
 * @returns {Promise<{ version?: unknown, routes?: unknown[] }>}
 */
async function readConfig(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`, { cause: error });
  }
}

/**
 * Loads a Build Output API v3 directory.
 * @param {string} dir
 * @returns {Promise<Output>}
 */
export async function loadOutput(dir) {
  const config = await readConfig(path.join(dir, "config.json"));
  if (config.version !== 3) {
    throw new Error(
      `config.json is Build Output API version ${config.version}; this server reads version 3`,
    );
  }
  return {
    files: await indexStatic(path.join(dir, "static")),
    functions: await indexFunctions(path.join(dir, "functions")),
    phases: compileRoutes(config.routes ?? []),
  };
}

/**
 * Looks a pathname up in the filesystem: the file itself, then its directory index.
 * @param {Output} output
 * @param {string} pathname
 * @returns {{ file: StaticFile | null, functionPath: string | null } | null}
 */
function lookup(output, pathname) {
  const directory = pathname.endsWith("/") ? pathname : `${pathname}/`;
  const file = output.files.get(pathname) ?? output.files.get(`${directory}index.html`) ?? null;
  if (file !== null) {
    return { file, functionPath: null };
  }
  return output.functions.has(pathname) ? { file: null, functionPath: pathname } : null;
}

/**
 * Replaces `$1`/`$name` references in a route destination.
 * @param {string} template
 * @param {RegExpExecArray} match
 */
function substitute(template, match) {
  return template.replace(/\$(\w+)/g, (reference, name) => {
    const value = /^\d+$/.test(name) ? match[Number(name)] : match.groups?.[name];
    return value ?? reference;
  });
}

/**
 * Runs the routes of one phase against the request state. Returns a terminal resolution when a
 * route ends the request with a status and no destination, otherwise null (the state was updated).
 * @param {Route[]} routes
 * @param {Output} output
 * @param {{ pathname: string, headers: Record<string, string>, status: number | undefined }} state
 * @returns {Resolution | null}
 */
function evaluate(routes, output, state) {
  for (const route of routes) {
    const match = route.pattern.exec(state.pathname);
    if (match === null) {
      continue;
    }
    const destination = route.dest === undefined ? undefined : substitute(route.dest, match);
    if (route.check && destination !== undefined && lookup(output, destination) === null) {
      continue;
    }
    Object.assign(state.headers, route.headers);
    if (route.status !== undefined) {
      state.status = route.status;
    }
    if (destination !== undefined) {
      state.pathname = destination;
    }
    if (route.continue) {
      continue;
    }
    if (destination === undefined && route.status !== undefined) {
      return { status: route.status, headers: state.headers, file: null, functionPath: null };
    }
    return null;
  }
  return null;
}

/**
 * Applies the error routes to a request that found nothing (or ended with an error status).
 * @param {Output} output
 * @param {string} originalPathname
 * @param {Resolution} failure
 * @returns {Resolution}
 */
function failWith(output, originalPathname, failure) {
  for (const route of output.phases.error) {
    const match = route.pattern.exec(originalPathname);
    if (match === null) {
      continue;
    }
    const found = route.dest === undefined ? null : lookup(output, substitute(route.dest, match));
    return {
      status: route.status ?? failure.status,
      headers: { ...failure.headers, ...route.headers },
      file: found?.file ?? null,
      functionPath: found?.functionPath ?? null,
    };
  }
  return failure;
}

/**
 * Resolves a request pathname the way the Build Output API describes: the routes before
 * `handle: filesystem`, the filesystem, the routes after it, then `miss`, then the error routes.
 * @param {Output} output
 * @param {string} pathname decoded request pathname
 * @returns {Resolution}
 */
export function resolveRequest(output, pathname) {
  const state = { pathname, headers: {}, status: undefined };
  // A path that exists after one phase is served without running the later phases.
  for (const routes of [output.phases.none, output.phases.filesystem, output.phases.miss]) {
    const terminal = evaluate(routes, output, state);
    if (terminal !== null) {
      return failWith(output, pathname, terminal);
    }
    if (lookup(output, state.pathname) !== null) {
      break;
    }
  }
  const found = lookup(output, state.pathname);
  if (found !== null) {
    return { status: state.status ?? 200, headers: state.headers, ...found };
  }
  return failWith(output, pathname, {
    status: 404,
    headers: state.headers,
    file: null,
    functionPath: null,
  });
}

/**
 * Picks the content coding for a response: the highest q-value the client allows (brotli before
 * gzip on a tie) among the variants the file has.
 * @param {string | undefined} header Accept-Encoding
 * @param {StaticFile} file
 * @returns {string | null}
 */
function negotiate(header, file) {
  const accepted = new Map();
  for (const part of (header ?? "").split(",")) {
    const [coding, ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters
      .map((parameter) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(parameter))
      .find(Boolean);
    if (coding) {
      accepted.set(coding, quality ? Number(quality[1]) : 1);
    }
  }
  let best = null;
  let bestQuality = 0;
  for (const coding of ENCODING_PREFERENCE.filter((candidate) => candidate in file.encodings)) {
    const quality = accepted.get(coding) ?? accepted.get("*") ?? 0;
    if (quality > bestQuality) {
      best = coding;
      bestQuality = quality;
    }
  }
  return best;
}

/**
 * @param {string} rawUrl request target
 * @returns {string} the decoded pathname (dot segments already removed by the URL parser)
 */
function decodePathname(rawUrl) {
  const pathname = decodeURIComponent(new URL(rawUrl, "http://localhost").pathname);
  if (pathname.includes("\0")) {
    throw new URIError("NUL byte in the path");
  }
  return pathname;
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {Resolution} resolution
 */
function respond(request, response, resolution) {
  const headers = { ...resolution.headers };
  let body;
  if (resolution.functionPath !== null) {
    body = Buffer.from(
      JSON.stringify({
        error: `The function ${resolution.functionPath} is not served by this static server; measure a deployed preview for API behaviour.`,
      }),
    );
    resolution = { ...resolution, status: 501 };
    headers["content-type"] = "application/json; charset=utf-8";
  } else if (resolution.file === null) {
    body = Buffer.from(`${resolution.status} ${STATUS_CODES[resolution.status] ?? "Error"}\n`);
    headers["content-type"] = "text/plain; charset=utf-8";
  } else {
    const { file } = resolution;
    const encoding = negotiate(request.headers["accept-encoding"], file);
    body = encoding === null ? file.body : file.encodings[encoding];
    headers["content-type"] = file.type;
    headers["cache-control"] ??= DEFAULT_CACHE_CONTROL;
    if (Object.keys(file.encodings).length > 0) {
      headers["vary"] =
        headers["vary"] === undefined ? "Accept-Encoding" : `${headers["vary"]}, Accept-Encoding`;
    }
    if (encoding !== null) {
      headers["content-encoding"] = encoding;
    }
  }
  headers["content-length"] = String(body.length);
  response.writeHead(resolution.status, headers);
  response.end(request.method === "HEAD" ? undefined : body);
}

/**
 * @param {Output} output
 * @returns {import("node:http").Server}
 */
export function createOutputServer(output) {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-length": "0" }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodePathname(request.url);
    } catch {
      response.writeHead(400, { "content-length": "0" }).end();
      return;
    }
    respond(request, response, resolveRequest(output, pathname));
  });
}

/**
 * Starts the server for the given command line.
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 * @returns {Promise<import("node:http").Server>} the listening server
 */
export async function main(argv, log = console.log) {
  const { dir, host, port } = parseArgs(argv);
  const server = createOutputServer(await loadOutput(dir));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  log(`Serving ${dir} on http://${host}:${server.address().port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
