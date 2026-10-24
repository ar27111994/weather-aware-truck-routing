// Tests for the local stack (card T10-ST): the gateway in scripts/stack/gateway.mjs, which serves the
// production build through the preview module and proxies /api to Django, and the commands of
// scripts/stack.sh that need neither Postgres nor Django. Everything here talks to real sockets on
// 127.0.0.1 with throw-away ports; nothing reaches the network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createGateway,
  forwardableHeaders,
  isApiPath,
  main,
  parseArgs,
  replyBadGateway,
} from "../stack/gateway.mjs";

const GATEWAY_SCRIPT = fileURLToPath(new URL("../stack/gateway.mjs", import.meta.url));

/** Everything a test opens or creates; closed or removed after the test, newest first. */
const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Listens on a free loopback port and returns it; the server is closed after the test. */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      cleanups.push(() => closeServer(server));
      resolve(server.address().port);
    });
  });
}

/** A port that nothing listens on right now. */
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * A stand-in for Django: records each request in full, then lets `respond` answer it. The default
 * answer is a small JSON document.
 */
async function startUpstream(respond = answerJson) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(req, res);
    });
  });
  return { port: await listen(server), seen };
}

function answerJson(_req, res) {
  res.writeHead(200, { "content-type": "application/json", "x-request-id": "from-django" });
  res.end('{"status":"ok"}');
}

/** A production build in miniature: the files the preview module serves. */
async function writeBuild() {
  const dir = await mkdtemp(path.join(tmpdir(), "stack-build-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Planner</title>");
  await writeFile(path.join(dir, "__spa-fallback.html"), "<!doctype html><title>Fallback</title>");
  await writeFile(path.join(dir, "assets", "app.js"), "export const app = 1;");
  return dir;
}

/** Starts a gateway over a miniature build in front of `upstreamPort`; returns its port. */
async function startGateway(upstreamPort) {
  const directory = await writeBuild();
  return listen(createGateway({ directory, upstreamPort }));
}

/** One request, with full control of the headers (fetch would not let a test set Host). */
function send(port, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: target, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("close", () => {
          if (!res.complete) reject(new Error("the response was cut off"));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function headerLines(rawHeaders, name) {
  const lines = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) lines.push(rawHeaders[i + 1]);
  }
  return lines;
}

describe("the gateway serves the production build", () => {
  test("a file of the build is served as it is", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    const res = await send(port, { path: "/assets/app.js" });

    assert.equal(res.status, 200);
    assert.equal(res.body, "export const app = 1;");
    assert.deepEqual(upstream.seen, []);
  });

  test("the home page is the built index", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    const res = await send(port, { path: "/" });

    assert.equal(res.status, 200);
    assert.match(res.body, /<title>Planner<\/title>/);
  });

  test("a client-side route falls back to the SPA shell, like on Vercel", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    const res = await send(port, { path: "/design" });

    assert.equal(res.status, 200);
    assert.match(res.body, /<title>Fallback<\/title>/);
    assert.deepEqual(upstream.seen, []);
  });
});

describe("the gateway proxies /api to Django", () => {
  test("a GET reaches Django with its path and query and the answer comes back whole", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    const res = await send(port, { path: "/api/v1/health/ready?probe=1" });

    assert.equal(res.status, 200);
    assert.equal(res.body, '{"status":"ok"}');
    assert.equal(res.headers["content-type"], "application/json");
    assert.equal(res.headers["x-request-id"], "from-django");
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].method, "GET");
    assert.equal(upstream.seen[0].url, "/api/v1/health/ready?probe=1");
  });

  test("a POST carries its method, body and content type, and the status of the answer", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(201, { "content-type": "application/json", location: "/api/v1/plans/p1" });
      res.end('{"plan_id":"p1"}');
    });
    const port = await startGateway(upstream.port);
    const body = '{"origin":{"label":"Salt Lake City"},"load_weight_lb":38000}';

    const res = await send(port, {
      method: "POST",
      path: "/api/v1/plans",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:4210" },
      body,
    });

    assert.equal(res.status, 201);
    assert.equal(res.headers.location, "/api/v1/plans/p1");
    assert.equal(upstream.seen[0].method, "POST");
    assert.equal(upstream.seen[0].body, body);
    assert.equal(upstream.seen[0].headers["content-type"], "application/json");
    assert.equal(upstream.seen[0].headers.origin, "http://127.0.0.1:4210");
  });

  test("a body without a length arrives whole", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/v1/plans",
          headers: { "content-type": "application/json" },
          agent: false,
        },
        (res) => res.resume().on("end", resolve),
      );
      req.on("error", reject);
      req.write('{"a":');
      req.write("1}");
      req.end();
    });

    assert.equal(upstream.seen[0].body, '{"a":1}');
  });

  test("the Host header goes through unchanged: Django must see the host the client used", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    await send(port, { path: "/api/v1/health", headers: { host: "stack.test:4210" } });

    assert.equal(upstream.seen[0].headers.host, "stack.test:4210");
  });

  test("x-forwarded-for reaches Django exactly as sent, as one line", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    await send(port, { path: "/api/v1/plans", headers: { "x-forwarded-for": "10.9.8.7" } });

    assert.equal(upstream.seen[0].headers["x-forwarded-for"], "10.9.8.7");
    assert.deepEqual(headerLines(upstream.seen[0].rawHeaders, "x-forwarded-for"), ["10.9.8.7"]);
  });

  test("the gateway adds no hop of its own: no x-forwarded-for when the client sent none", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    await send(port, { path: "/api/v1/plans" });

    const { headers } = upstream.seen[0];
    for (const name of ["x-forwarded-for", "x-real-ip", "forwarded", "via", "x-forwarded-host"]) {
      assert.equal(headers[name], undefined, name);
    }
  });

  test("hop-by-hop headers stop at the gateway, in both directions", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        connection: "x-hop",
        "x-hop": "private to the upstream connection",
        "proxy-authenticate": "Basic",
        "x-kept": "yes",
      });
      res.end("ok");
    });
    const port = await startGateway(upstream.port);

    const res = await send(port, {
      path: "/api/v1/health",
      headers: {
        connection: "keep-alive, x-trace",
        "x-trace": "private to the client connection",
        "keep-alive": "timeout=5",
        te: "trailers",
        "proxy-authorization": "Basic Zm9v",
        "x-other": "kept",
      },
    });

    const { headers } = upstream.seen[0];
    assert.equal(headers["x-other"], "kept");
    for (const name of ["x-trace", "keep-alive", "te", "proxy-authorization"]) {
      assert.equal(headers[name], undefined, name);
    }
    assert.equal(res.headers["x-kept"], "yes");
    assert.equal(res.headers["x-hop"], undefined);
    assert.equal(res.headers["proxy-authenticate"], undefined);
  });

  test("a header that comes twice in the answer stays two lines", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.end("ok");
    });
    const port = await startGateway(upstream.port);

    const res = await send(port, { path: "/api/v1/health" });

    assert.deepEqual(headerLines(res.rawHeaders, "set-cookie"), ["a=1; Path=/", "b=2; Path=/"]);
  });

  test("an error status of Django is passed on, not replaced", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(422, { "content-type": "application/problem+json" });
      res.end('{"code":"validation_failed"}');
    });
    const port = await startGateway(upstream.port);

    const res = await send(port, { method: "POST", path: "/api/v1/plans", body: "{}" });

    assert.equal(res.status, 422);
    assert.equal(res.body, '{"code":"validation_failed"}');
  });

  test("a Django that is not listening gives 502 with a problem document", async () => {
    const port = await startGateway(await freePort());

    const res = await send(port, { path: "/api/v1/health" });

    assert.equal(res.status, 502);
    assert.equal(res.headers["content-type"], "application/problem+json");
    const problem = JSON.parse(res.body);
    assert.equal(problem.status, 502);
    assert.equal(problem.title, "Bad Gateway");
    assert.match(problem.detail, /did not answer/);
  });

  test("a client that gives up ends the request to Django as well", async () => {
    let upstreamClosed;
    const closed = new Promise((resolve) => (upstreamClosed = resolve));
    const upstream = await startUpstream((_req, res) => {
      res.on("close", upstreamClosed);
    });
    const port = await startGateway(upstream.port);

    const req = http.request({ host: "127.0.0.1", port, path: "/api/v1/plans", agent: false });
    req.on("error", () => {});
    req.end();
    while (upstream.seen.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    req.destroy();

    await closed;
  });

  test("a Django that dies halfway through an answer cuts the client's answer off", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("part of the answer");
      setTimeout(() => res.socket.destroy(), 20);
    });
    const port = await startGateway(upstream.port);

    await assert.rejects(send(port, { path: "/api/v1/plans/p1" }), /cut off|aborted|reset/);
  });
});

describe("the gateway never proxies a path outside /api", () => {
  test("look-alike paths are the static server's business", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    for (const target of [
      "/apix",
      "/api-docs/",
      "/x/api/v1/health",
      "/API/v1/health",
      "/index.html?next=/api/v1/health",
      "//example.invalid/api/v1/health",
    ]) {
      const res = await send(port, { path: target });
      assert.equal(res.status, 200, target);
      assert.match(res.body, /<title>(Planner|Fallback)<\/title>/, target);
    }

    assert.deepEqual(upstream.seen, []);
  });

  test("/api and /api/ are proxied", async () => {
    const upstream = await startUpstream();
    const port = await startGateway(upstream.port);

    await send(port, { path: "/api" });
    await send(port, { path: "/api/" });

    assert.deepEqual(
      upstream.seen.map((request) => request.url),
      ["/api", "/api/"],
    );
  });

  test("isApiPath decides on the path alone", () => {
    for (const target of ["/api", "/api/", "/api/v1/health", "/api?x=1", "/api/v1/plans?a=/b"]) {
      assert.equal(isApiPath(target), true, target);
    }
    for (const target of ["/", "/apix", "/api-docs", "/a/api/b", "/API/x", "/?next=/api/x", ""]) {
      assert.equal(isApiPath(target), false, target);
    }
  });
});

describe("the headers a proxy may forward", () => {
  test("forwardableHeaders drops the fixed hop-by-hop set and what Connection names", () => {
    const kept = forwardableHeaders({
      host: ["a.test"],
      connection: ["close, X-Named"],
      "x-named": ["1"],
      "keep-alive": ["timeout=5"],
      "transfer-encoding": ["chunked"],
      trailer: ["x"],
      upgrade: ["websocket"],
      "x-forwarded-for": ["10.0.0.1"],
    });

    assert.deepEqual(kept, { host: "a.test", "x-forwarded-for": "10.0.0.1" });
  });

  test("forwardableHeaders keeps every line of a repeated header", () => {
    const kept = forwardableHeaders({ "x-twice": ["one", "two"], host: ["a.test"] });

    assert.deepEqual(kept, { "x-twice": ["one", "two"], host: "a.test" });
  });

  test("replyBadGateway cuts the connection when the answer has already started", () => {
    let destroyed = false;
    const res = {
      headersSent: true,
      writeHead() {
        assert.fail("a second head must never be written");
      },
      destroy() {
        destroyed = true;
      },
    };

    replyBadGateway(res, "127.0.0.1", 8110);

    assert.equal(destroyed, true);
  });
});

describe("the gateway as a process", () => {
  test("parseArgs knows --dir and --host and refuses anything else", () => {
    assert.deepEqual(parseArgs(["--dir", "build/client", "--host", "0.0.0.0"]), {
      dir: "build/client",
      host: "0.0.0.0",
    });
    assert.equal(parseArgs([]).host, "127.0.0.1");
    assert.match(parseArgs([]).dir, /frontend[\\/]build[\\/]client$/);
    assert.throws(() => parseArgs(["--port", "4210"]), /usage: gateway\.mjs/);
    assert.throws(() => parseArgs(["--dir"]), /usage: gateway\.mjs/);
  });

  test("main serves on E2E_PORT and proxies to STACK_DJANGO_PORT", async () => {
    const upstream = await startUpstream();
    const directory = await writeBuild();
    const port = await freePort();
    const lines = [];

    const server = await main(
      ["--dir", directory],
      { E2E_PORT: String(port), STACK_DJANGO_PORT: String(upstream.port) },
      (line) => lines.push(line),
    );
    cleanups.push(() => closeServer(server));

    assert.equal((await send(port, { path: "/design" })).status, 200);
    assert.equal((await send(port, { path: "/api/v1/health" })).body, '{"status":"ok"}');
    assert.match(lines.join("\n"), new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  });

  test("main refuses to serve on another port when its own is taken", async () => {
    const blocker = http.createServer();
    const taken = await listen(blocker);
    const directory = await writeBuild();

    await assert.rejects(
      main(["--dir", directory], { E2E_PORT: String(taken), STACK_DJANGO_PORT: "8110" }, () => {}),
      new Error(`Port ${taken} is already in use; refusing to serve on another port.`),
    );
  });

  test("main reports any other reason why it cannot listen", async () => {
    const directory = await writeBuild();
    const port = await freePort();

    await assert.rejects(
      main(
        ["--dir", directory, "--host", "192.0.2.1"],
        { E2E_PORT: String(port), STACK_DJANGO_PORT: "8110" },
        () => {},
      ),
      /^Error: Preview server failed: .*(EADDRNOTAVAIL|EINVAL)/,
    );
  });

  test("main insists on a build to serve", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "stack-empty-"));
    cleanups.push(() => rm(empty, { recursive: true, force: true }));

    await assert.rejects(
      main(
        ["--dir", empty],
        { E2E_PORT: String(await freePort()), STACK_DJANGO_PORT: "8110" },
        () => {},
      ),
      /not a frontend production build.*pnpm build/,
    );
  });

  test("main names STACK_DJANGO_PORT when it is missing or not a port", async () => {
    const directory = await writeBuild();
    const port = String(await freePort());

    // The first case sets nothing at all: the gateway port falls back to the preview's default
    // while it is being read, and the missing port of Django is what stops it, before any bind.
    for (const env of [
      {},
      { E2E_PORT: port },
      { E2E_PORT: port, STACK_DJANGO_PORT: "not-a-port" },
      { E2E_PORT: port, STACK_DJANGO_PORT: "70000" },
    ]) {
      await assert.rejects(
        main(["--dir", directory], env, () => {}),
        /STACK_DJANGO_PORT must be a port number/,
      );
    }
  });

  test("main refuses an E2E_PORT that is not a port", async () => {
    await assert.rejects(
      main([], { E2E_PORT: "abc", STACK_DJANGO_PORT: "8110" }, () => {}),
      /E2E_PORT must be a port number, got "abc"/,
    );
  });

  test("run as a script it serves and proxies until it is stopped", async () => {
    const upstream = await startUpstream();
    const directory = await writeBuild();
    const port = await freePort();
    const child = spawn(process.execPath, [GATEWAY_SCRIPT, "--dir", directory], {
      env: { ...process.env, E2E_PORT: String(port), STACK_DJANGO_PORT: String(upstream.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", (chunk) => resolve(chunk.toString("utf8")));
      });
      assert.match(line, new RegExp(`http://127\\.0\\.0\\.1:${port}`));

      const res = await send(port, {
        path: "/api/v1/health",
        headers: { "x-forwarded-for": "10.9.8.7" },
      });

      assert.equal(res.status, 200);
      assert.equal(upstream.seen[0].headers["x-forwarded-for"], "10.9.8.7");
    } finally {
      child.kill();
    }
  });

  test("run as a script it explains a bad port and exits with code 1", async () => {
    const child = spawn(process.execPath, [GATEWAY_SCRIPT], {
      env: { ...process.env, E2E_PORT: "abc", STACK_DJANGO_PORT: "8110" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const code = await new Promise((resolve) => child.once("close", resolve));

    assert.equal(code, 1);
    assert.match(stderr, /E2E_PORT must be a port number/);
  });
});
