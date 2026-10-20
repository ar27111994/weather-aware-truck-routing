// Tests for scripts/serve-vercel-output.mjs: the local server that serves a `vercel build` output
// the way Vercel serves it (routes from config.json, brotli/gzip), so Lighthouse measures a
// production-faithful response instead of a compression-less preview server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import {
  createOutputServer,
  loadOutput,
  main,
  parseArgs,
  resolveRequest,
} from "../serve-vercel-output.mjs";

const SCRIPT = fileURLToPath(new URL("../serve-vercel-output.mjs", import.meta.url));

// The routes `vercel build` writes for this repo's vercel.json (trimmed to short header values).
const ROUTES = [
  {
    src: "^(?:/(.*))$",
    headers: {
      "Strict-Transport-Security": "max-age=63072000",
      "X-Content-Type-Options": "nosniff",
    },
    continue: true,
  },
  {
    src: "^(?:/((?!api/).*))$",
    headers: { "Content-Security-Policy": "default-src 'self'", "X-Frame-Options": "DENY" },
    continue: true,
  },
  {
    src: "^/assets(?:/(.*))$",
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    continue: true,
  },
  {
    src: "^(?:/((?!assets/|api/).*))$",
    headers: { "Cache-Control": "public, max-age=0, must-revalidate" },
    continue: true,
  },
  { handle: "filesystem" },
  { src: "^/api(?:/(.*))$", dest: "/api/index", check: true },
  { src: "^(?:/((?!api/|assets/)[^.]*))$", dest: "/__spa-fallback.html", check: true },
  { src: "^/api(/.*)?$", status: 404 },
  { handle: "error" },
  { status: 404, src: "^(?!/api).*$", dest: "/404.html" },
  { handle: "miss" },
  { src: "^/api/(.+)(?:\\.(?:py))$", dest: "/api/$1", check: true },
];

const LONG_TEXT = "Haulcast routes trucks around weather. ".repeat(200);
const FILES = {
  "index.html": `<!doctype html><title>home</title>${LONG_TEXT}`,
  "methodology/index.html": `<!doctype html><title>methodology</title>${LONG_TEXT}`,
  "__spa-fallback.html": `<!doctype html><title>fallback</title>${LONG_TEXT}`,
  "404.html": "<!doctype html><title>not found</title>",
  "assets/app-abc123.js": `console.log(${JSON.stringify(LONG_TEXT)});`,
  "assets/tiny.js": "x=1",
  "assets/logo.png": Buffer.alloc(4096, 7),
  "assets/data.json": JSON.stringify({ text: LONG_TEXT }),
  "assets/icon.svg": `<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(600)}</svg>`,
  "assets/font.woff2": Buffer.alloc(4096, 9),
};

/** Writes a `.vercel/output` look-alike into a fresh temp directory and returns its path. */
async function writeOutput({ routes = ROUTES, files = FILES, withFunction = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "serve-output-"));
  await writeFile(path.join(dir, "config.json"), JSON.stringify({ version: 3, routes }));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, "static", name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  if (withFunction) {
    const fn = path.join(dir, "functions", "api", "index.func");
    await mkdir(fn, { recursive: true });
    await writeFile(path.join(fn, ".vc-config.json"), "{}");
  }
  return dir;
}

/** Issues a raw request (no client-side decoding, no path normalisation) and buffers the reply. */
function request(server, { method = "GET", target = "/", headers = {} } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** Runs `body` against a server for a throw-away output built from `options`, then cleans up. */
async function withServer(options, body) {
  const dir = await writeOutput(options);
  const server = createOutputServer(await loadOutput(dir));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await body(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

describe("served output", () => {
  let dir;
  let server;

  before(async () => {
    dir = await writeOutput();
    server = createOutputServer(await loadOutput(dir));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  test("serves a page with its content type, length and the headers of every matching route", async () => {
    const res = await request(server, { target: "/", headers: { "accept-encoding": "identity" } });

    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(res.headers["content-length"], String(Buffer.byteLength(FILES["index.html"])));
    assert.equal(res.headers["strict-transport-security"], "max-age=63072000");
    assert.equal(res.headers["content-security-policy"], "default-src 'self'");
    assert.equal(res.headers["cache-control"], "public, max-age=0, must-revalidate");
    assert.equal(res.body.toString("utf8"), FILES["index.html"]);
  });

  test("gives hashed assets the immutable cache header and keeps the page headers off the API", async () => {
    const asset = await request(server, {
      target: "/assets/app-abc123.js",
      headers: { "accept-encoding": "identity" },
    });
    const api = await request(server, { target: "/api/v1/health" });

    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(api.headers["content-security-policy"], undefined);
  });

  test("compresses text with brotli when the client accepts it, and the bytes round-trip", async () => {
    const res = await request(server, {
      target: "/",
      headers: { "accept-encoding": "gzip, deflate, br" },
    });

    assert.equal(res.headers["content-encoding"], "br");
    assert.equal(res.headers["vary"], "Accept-Encoding");
    assert.equal(res.headers["content-length"], String(res.body.length));
    assert.ok(res.body.length < Buffer.byteLength(FILES["index.html"]) / 4);
    assert.equal(brotliDecompressSync(res.body).toString("utf8"), FILES["index.html"]);
  });

  test("falls back to gzip when brotli is not accepted", async () => {
    const res = await request(server, {
      target: "/",
      headers: { "accept-encoding": "gzip, deflate" },
    });

    assert.equal(res.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(res.body).toString("utf8"), FILES["index.html"]);
  });

  test("honours q-values: q=0 disables an encoding and a higher q wins", async () => {
    const noBrotli = await request(server, {
      target: "/",
      headers: { "accept-encoding": "br;q=0, gzip" },
    });
    const preferGzip = await request(server, {
      target: "/",
      headers: { "accept-encoding": "br;q=0.4, gzip;q=0.9" },
    });
    const wildcard = await request(server, { target: "/", headers: { "accept-encoding": "*" } });

    assert.equal(noBrotli.headers["content-encoding"], "gzip");
    assert.equal(preferGzip.headers["content-encoding"], "gzip");
    assert.equal(wildcard.headers["content-encoding"], "br");
  });

  test("serves identity (still varying on Accept-Encoding) without an acceptable encoding", async () => {
    const none = await request(server, { target: "/" });
    const refused = await request(server, {
      target: "/",
      headers: { "accept-encoding": "identity" },
    });

    for (const res of [none, refused]) {
      assert.equal(res.headers["content-encoding"], undefined);
      assert.equal(res.headers["vary"], "Accept-Encoding");
      assert.equal(res.body.toString("utf8"), FILES["index.html"]);
    }
  });

  test("never compresses small files or already-compressed binaries", async () => {
    const encodings = { "accept-encoding": "gzip, br" };
    const tiny = await request(server, { target: "/assets/tiny.js", headers: encodings });
    const png = await request(server, { target: "/assets/logo.png", headers: encodings });
    const woff2 = await request(server, { target: "/assets/font.woff2", headers: encodings });

    for (const res of [tiny, png, woff2]) {
      assert.equal(res.headers["content-encoding"], undefined);
      assert.equal(res.headers["vary"], undefined);
    }
    assert.equal(png.headers["content-type"], "image/png");
    assert.equal(woff2.headers["content-type"], "font/woff2");
  });

  test("compresses JSON and SVG as well", async () => {
    const json = await request(server, {
      target: "/assets/data.json",
      headers: { "accept-encoding": "br" },
    });
    const svg = await request(server, {
      target: "/assets/icon.svg",
      headers: { "accept-encoding": "gzip" },
    });

    assert.equal(json.headers["content-encoding"], "br");
    assert.equal(json.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(svg.headers["content-encoding"], "gzip");
    assert.equal(svg.headers["content-type"], "image/svg+xml");
  });

  test("serves a directory index with and without the trailing slash", async () => {
    const plain = await request(server, {
      target: "/methodology",
      headers: { "accept-encoding": "identity" },
    });
    const slashed = await request(server, {
      target: "/methodology/",
      headers: { "accept-encoding": "identity" },
    });

    assert.equal(plain.body.toString("utf8"), FILES["methodology/index.html"]);
    assert.equal(slashed.body.toString("utf8"), FILES["methodology/index.html"]);
  });

  test("answers an unknown page with the SPA fallback as a 200 rewrite", async () => {
    const res = await request(server, {
      target: "/trips/abc",
      headers: { "accept-encoding": "identity" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.toString("utf8"), FILES["__spa-fallback.html"]);
  });

  test("a missing asset is a 404 page, not the SPA fallback", async () => {
    const res = await request(server, {
      target: "/assets/missing-0000.js",
      headers: { "accept-encoding": "identity" },
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.toString("utf8"), FILES["404.html"]);
  });

  test("answers API paths with an explicit 501 because the Python function is not served", async () => {
    const res = await request(server, { target: "/api/v1/health" });

    assert.equal(res.status, 501);
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.match(JSON.parse(res.body.toString("utf8")).error, /function/i);
  });

  test("HEAD returns the headers of GET without a body", async () => {
    const get = await request(server, { target: "/", headers: { "accept-encoding": "br" } });
    const head = await request(server, {
      method: "HEAD",
      target: "/",
      headers: { "accept-encoding": "br" },
    });

    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], get.headers["content-length"]);
    assert.equal(head.headers["content-encoding"], "br");
    assert.equal(head.body.length, 0);
  });

  test("rejects other methods with 405 and an Allow header", async () => {
    const res = await request(server, { method: "POST", target: "/" });

    assert.equal(res.status, 405);
    assert.equal(res.headers["allow"], "GET, HEAD");
  });

  test("rejects malformed percent-encoding with 400", async () => {
    const res = await request(server, { target: "/%E0%A4%A" });

    assert.equal(res.status, 400);
  });

  test("cannot be walked out of the static directory", async () => {
    for (const target of [
      "/../config.json",
      "/%2e%2e/config.json",
      "/assets/../../config.json",
      "/%00",
    ]) {
      const res = await request(server, { target, headers: { "accept-encoding": "identity" } });

      assert.notEqual(res.status, 200, target);
      assert.ok(!res.body.toString("utf8").includes('"version"'), target);
    }
  });
});

describe("routing", () => {
  test("a later header route overrides an earlier one for the same header, ignoring case", async () => {
    const routes = [
      { src: "^/(.*)$", headers: { "cache-control": "no-store", "X-One": "1" }, continue: true },
      { src: "^/(.*)$", headers: { "Cache-Control": "public, max-age=60" }, continue: true },
      { handle: "filesystem" },
    ];
    const dir = await writeOutput({ routes });
    try {
      const output = await loadOutput(dir);

      const result = resolveRequest(output, "/");

      assert.equal(result.headers["cache-control"], "public, max-age=60");
      assert.equal(result.headers["x-one"], "1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing API path without a function is a bare text 404 (the error page is for other paths)", async () => {
    await withServer({ withFunction: false }, async (server) => {
      const res = await request(server, { target: "/api/v1/health" });

      assert.equal(res.status, 404);
      assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(res.body.toString("utf8"), "404 Not Found\n");
    });
  });

  test("names a status without a standard reason phrase generically", async () => {
    const routes = [{ handle: "filesystem" }, { src: "^/odd$", status: 499 }];

    await withServer({ routes }, async (server) => {
      const res = await request(server, { target: "/odd" });

      assert.equal(res.status, 499);
      assert.equal(res.body.toString("utf8"), "499 Error\n");
    });
  });

  test("appends Accept-Encoding to a Vary header a route already set", async () => {
    const routes = [
      { src: "^/(.*)$", headers: { Vary: "Origin" }, continue: true },
      { handle: "filesystem" },
    ];

    await withServer({ routes }, async (server) => {
      const res = await request(server, { target: "/", headers: { "accept-encoding": "br" } });

      assert.equal(res.headers["vary"], "Origin, Accept-Encoding");
    });
  });

  test("serves a file with an unknown extension as an octet stream", async () => {
    const files = { "assets/blob.bin": Buffer.alloc(2048, 1) };

    await withServer({ routes: [{ handle: "filesystem" }], files }, async (server) => {
      const res = await request(server, {
        target: "/assets/blob.bin",
        headers: { "accept-encoding": "br" },
      });

      assert.equal(res.headers["content-type"], "application/octet-stream");
      assert.equal(res.headers["content-encoding"], undefined);
    });
  });

  test("a rewrite without check is final, with check it only applies when the target exists", async () => {
    const routes = [
      { src: "^/old$", dest: "/index.html" },
      { src: "^/page$", dest: "/nowhere.html", check: true },
      { handle: "filesystem" },
    ];
    const dir = await writeOutput({ routes });
    try {
      const output = await loadOutput(dir);

      assert.equal(resolveRequest(output, "/old").file.urlPath, "/index.html");
      assert.equal(resolveRequest(output, "/page").status, 404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("substitutes numbered and named capture groups into the destination", async () => {
    const routes = [
      { handle: "filesystem" },
      { src: "^/docs/(?<section>[a-z]+)/(.*)$", dest: "/$section/$2/index.html", check: true },
    ];
    const dir = await writeOutput({
      routes,
      files: { "methodology/deep/index.html": "x".repeat(10) },
    });
    try {
      const output = await loadOutput(dir);

      assert.equal(
        resolveRequest(output, "/docs/methodology/deep").file.urlPath,
        "/methodology/deep/index.html",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a status route without a destination ends the request with that status", async () => {
    const routes = [{ handle: "filesystem" }, { src: "^/gone$", status: 410 }];
    const dir = await writeOutput({ routes });
    try {
      const output = await loadOutput(dir);

      assert.equal(resolveRequest(output, "/gone").status, 410);
      assert.equal(resolveRequest(output, "/gone").file, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a miss route can rewrite a path that exists nowhere else", async () => {
    const routes = [
      { handle: "filesystem" },
      { handle: "miss" },
      { src: "^/legacy$", dest: "/index.html", check: true },
    ];
    const dir = await writeOutput({ routes });
    try {
      const output = await loadOutput(dir);

      assert.equal(resolveRequest(output, "/legacy").file.urlPath, "/index.html");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file that exists wins over every rewrite after the filesystem handler", async () => {
    const routes = [{ handle: "filesystem" }, { src: "^/index.html$", dest: "/404.html" }];
    const dir = await writeOutput({ routes });
    try {
      const output = await loadOutput(dir);

      assert.equal(resolveRequest(output, "/index.html").file.urlPath, "/index.html");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unmatched path without an error page is a bare 404", async () => {
    const dir = await writeOutput({
      routes: [{ handle: "filesystem" }],
      files: { "index.html": "ok" },
    });
    try {
      const output = await loadOutput(dir);

      assert.deepEqual(resolveRequest(output, "/nope"), {
        status: 404,
        headers: {},
        file: null,
        functionPath: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves a capture reference that matched nothing literal instead of inventing a value", async () => {
    const routes = [{ handle: "filesystem" }, { src: "^/x$", dest: "/$1.html", check: true }];
    const files = { "undefined.html": "wrong", "$1.html": "literal" };
    const dir = await writeOutput({ routes, files });
    try {
      const output = await loadOutput(dir);

      assert.equal(resolveRequest(output, "/x").file.urlPath, "/$1.html");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("error routes can add headers and keep the failure status without naming a page", async () => {
    const routes = [
      { handle: "filesystem" },
      { handle: "error" },
      { src: "^/.*$", headers: { "X-Error": "1" } },
    ];
    const dir = await writeOutput({ routes, files: { "index.html": "ok" } });
    try {
      const output = await loadOutput(dir);

      assert.deepEqual(resolveRequest(output, "/missing"), {
        status: 404,
        headers: { "x-error": "1" },
        file: null,
        functionPath: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an output without any routes still serves its files", async () => {
    const dir = await writeOutput({ files: { "index.html": "ok" } });
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ version: 3 }));
    try {
      const output = await loadOutput(dir);

      assert.equal(resolveRequest(output, "/").file.urlPath, "/index.html");
      assert.equal(resolveRequest(output, "/missing").status, 404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses route features it cannot honour instead of serving something different", async () => {
    const unsupported = [
      { src: "^/x$", has: [{ type: "header", key: "x" }] },
      { src: "^/x$", methods: ["GET"] },
      { src: "^/x$", missing: [{ type: "cookie", key: "a" }] },
      { handle: "hit" },
      { dest: "/index.html" },
      "not a route",
      null,
    ];
    for (const route of unsupported) {
      const dir = await writeOutput({ routes: [route] });
      try {
        await assert.rejects(loadOutput(dir), /unsupported/i, JSON.stringify(route));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("refuses a missing, malformed or non-v3 config.json", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "serve-output-"));
    const broken = await writeOutput();
    const old = await writeOutput();
    await writeFile(path.join(broken, "config.json"), "{ not json");
    await writeFile(path.join(old, "config.json"), JSON.stringify({ version: 2, routes: [] }));
    try {
      await assert.rejects(loadOutput(empty), /cannot read .*config\.json/);
      await assert.rejects(loadOutput(broken), /config\.json is not valid JSON/);
      await assert.rejects(loadOutput(old), /version 3/);
    } finally {
      await Promise.all(
        [empty, broken, old].map((dir) => rm(dir, { recursive: true, force: true })),
      );
    }
  });
});

describe("command line", () => {
  test("parseArgs returns the defaults and accepts overrides", () => {
    assert.deepEqual(parseArgs([]), { dir: ".vercel/output", host: "127.0.0.1", port: 4173 });
    assert.deepEqual(parseArgs(["--dir", "out", "--host", "0.0.0.0", "--port", "0"]), {
      dir: "out",
      host: "0.0.0.0",
      port: 0,
    });
  });

  test("parseArgs rejects unknown flags, missing values and invalid ports", () => {
    assert.throws(() => parseArgs(["--nope"]), /unknown/i);
    assert.throws(() => parseArgs(["--dir"]), /requires a value/i);
    assert.throws(() => parseArgs(["--port", "http"]), /port/i);
    assert.throws(() => parseArgs(["--port", "70000"]), /port/i);
  });

  test("main serves the directory and prints the line Lighthouse CI waits for", async () => {
    const dir = await writeOutput();
    const lines = [];
    const server = await main(["--dir", dir, "--port", "0"], (line) => lines.push(line));
    try {
      const { port } = server.address();
      const res = await request(server, {
        target: "/",
        headers: { "accept-encoding": "identity" },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(lines, [`Serving ${dir} on http://127.0.0.1:${port}`]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("main rejects when the port is already taken", async () => {
    const dir = await writeOutput();
    const first = await main(["--dir", dir, "--port", "0"], () => {});
    try {
      await assert.rejects(
        main(["--dir", dir, "--port", String(first.address().port)], () => {}),
        /EADDRINUSE/,
      );
    } finally {
      await new Promise((resolve) => first.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run as a script it serves until stopped and prints the ready line", async () => {
    const dir = await writeOutput();
    const child = spawn(process.execPath, [SCRIPT, "--dir", dir, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", (chunk) => resolve(chunk.toString("utf8")));
      });
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(line)?.[0];
      assert.ok(url, line);

      const res = await fetch(`${url}/methodology`);

      assert.equal(res.status, 200);
      assert.match(await res.text(), /methodology/);
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run as a script it reports a bad output directory and exits with code 1", async () => {
    const child = spawn(
      process.execPath,
      [SCRIPT, "--dir", path.join(tmpdir(), "no-such-output")],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const code = await new Promise((resolve) => child.once("close", resolve));

    assert.equal(code, 1);
    assert.match(stderr, /cannot read .*config\.json/);
  });
});
