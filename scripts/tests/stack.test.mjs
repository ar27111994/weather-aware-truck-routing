// Tests for the local stack (card T10-ST): the gateway in scripts/stack/gateway.mjs, which serves the
// production build through the preview module and proxies /api to Django, and the commands of
// scripts/stack.sh that need neither Postgres nor Django. Everything here talks to real sockets on
// 127.0.0.1 with throw-away ports; nothing reaches the network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
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

// --------------------------------------------------------------------------------------------------
// scripts/stack.sh: the commands that need neither Postgres nor Django. `up` itself (database,
// roles, migrations, waitress, the real gateway) is proven by the run in docs/STACK.md and by the
// `stack` workflow, which start the real thing.
// --------------------------------------------------------------------------------------------------

const STACK_SH = fileURLToPath(new URL("../stack.sh", import.meta.url)).replaceAll("\\", "/");
const STACK_VARIABLES = [
  "STACK_GATEWAY_PORT",
  "STACK_DJANGO_PORT",
  "STACK_DATABASE_NAME",
  "STACK_DATABASE_URL",
  "STACK_REPLAY_NOW",
  "STACK_STATE_DIR",
  "STACK_CLIENT_DIR",
];
/** A server that answers every request with "ok" on DUMMY_PORT: stands in for a started service. */
const DUMMY_SERVER =
  "require('node:http').createServer((q, r) => r.end('ok')).listen(Number(process.env.DUMMY_PORT), '127.0.0.1')";

/** The environment of a child: no coverage directory (its report would merge into the gate's). */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_V8_COVERAGE;
  return env;
}

/** Runs scripts/stack.sh with exactly the STACK_ variables of `extra`. */
function runStack(args, extra = {}) {
  const env = childEnv(extra);
  for (const name of STACK_VARIABLES) {
    if (!(name in extra)) delete env[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [STACK_SH, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function makeDirectory(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir.replaceAll("\\", "/");
}

/** Settings for a command that looks at ports: a state directory and two ports nobody holds. */
async function freeSettings() {
  return {
    STACK_GATEWAY_PORT: String(await freePort()),
    STACK_DJANGO_PORT: String(await freePort()),
    STACK_STATE_DIR: await makeDirectory("stack-state-"),
  };
}

function parseEnvLines(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPort(port, open) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await canConnect(port)) === open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`port ${port} never became ${open ? "open" : "closed"}`);
}

/**
 * Starts a dummy service the way `stack.sh up` starts a real one (a background child of bash) and
 * returns the pid that bash reports for it: the one `stack.sh` writes into its pid files.
 */
async function startServiceLikeUp(port) {
  const pid = await new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      ["-c", `node -e "${DUMMY_SERVER}" >/dev/null 2>&1 </dev/null & echo $!`],
      { env: childEnv({ DUMMY_PORT: String(port) }), stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("error", reject);
    child.once("close", () => resolve(out.trim()));
  });
  cleanups.push(
    () =>
      new Promise((resolve) => {
        spawn("bash", ["-c", `kill ${pid} 2>/dev/null || true`]).once("close", resolve);
      }),
  );
  await waitForPort(port, true);
  return pid;
}

/** A process that is not part of any stack and has the same name as the stack's services. */
async function startBystander(port) {
  const child = spawn(process.execPath, ["-e", DUMMY_SERVER], {
    env: childEnv({ DUMMY_PORT: String(port) }),
    stdio: "ignore",
  });
  cleanups.push(() => child.kill());
  await waitForPort(port, true);
  return child;
}

describe("stack.sh usage and settings", () => {
  test("no command, or an unknown one, is a usage error", async () => {
    for (const args of [[], ["frobnicate"]]) {
      const res = await runStack(args);

      assert.equal(res.status, 2, args.join(" "));
      assert.match(res.stderr, /usage: .*stack\.sh up/);
    }
  });

  test("a setting that cannot work is refused by name, before anything starts", async () => {
    const state = await makeDirectory("stack-state-");
    const cases = [
      [{ STACK_GATEWAY_PORT: "abc" }, /STACK_GATEWAY_PORT must be a port number/],
      [{ STACK_DJANGO_PORT: "70000" }, /STACK_DJANGO_PORT must be a port number/],
      [
        { STACK_GATEWAY_PORT: "4300", STACK_DJANGO_PORT: "4300" },
        /STACK_GATEWAY_PORT and STACK_DJANGO_PORT must differ/,
      ],
      [{ STACK_DATABASE_NAME: "Bad-Name" }, /STACK_DATABASE_NAME must be/],
      [{ STACK_REPLAY_NOW: "2026-10-24T05:30:00" }, /STACK_REPLAY_NOW must be an ISO 8601 instant/],
      [{ STACK_REPLAY_NOW: "yesterday" }, /STACK_REPLAY_NOW must be an ISO 8601 instant/],
    ];

    for (const [extra, message] of cases) {
      const res = await runStack(["env"], { ...extra, STACK_STATE_DIR: state });

      assert.equal(res.status, 1, JSON.stringify(extra));
      assert.match(res.stderr, message, JSON.stringify(extra));
    }
  });
});

describe("stack.sh env", () => {
  test("prints the clock, the URLs and one prefilled link per trip", async () => {
    const res = await runStack(["env"], {
      STACK_REPLAY_NOW: "2026-10-24T05:30:00Z",
      STACK_GATEWAY_PORT: "4310",
      STACK_DJANGO_PORT: "8310",
      STACK_STATE_DIR: await makeDirectory("stack-state-"),
    });

    assert.equal(res.status, 0, res.stderr);
    const values = parseEnvLines(res.stdout);
    assert.equal(values.HAULCAST_REPLAY_NOW, "2026-10-24T05:30:00Z");
    assert.equal(values.STACK_URL, "http://127.0.0.1:4310");
    assert.equal(values.STACK_API_URL, "http://127.0.0.1:4310/api/v1");
    assert.equal(values.STACK_DJANGO_URL, "http://127.0.0.1:8310");
    const links = Object.keys(values).filter((name) => name.startsWith("STACK_LINK_"));
    assert.deepEqual(links, [
      "STACK_LINK_SLC_DEN",
      "STACK_LINK_CHI_DEN",
      "STACK_LINK_NEWARK_JC",
      "STACK_LINK_LA_PHX",
    ]);
  });

  test("a prefilled link carries both places, the departure, the load and a scenario", async () => {
    const res = await runStack(["env"], {
      STACK_REPLAY_NOW: "2026-10-24T05:30:00Z",
      STACK_STATE_DIR: await makeDirectory("stack-state-"),
    });

    const link = new URL(parseEnvLines(res.stdout).STACK_LINK_SLC_DEN);

    assert.equal(link.origin, "http://127.0.0.1:4210");
    assert.equal(link.pathname, "/");
    assert.equal(
      link.searchParams.get("origin"),
      "Salt Lake City, Utah, United States@40.7608,-111.891",
    );
    assert.equal(
      link.searchParams.get("destination"),
      "Denver, Colorado, United States@39.7392,-104.9903",
    );
    assert.equal(link.searchParams.get("depart"), "2026-10-24T06:30Z");
    assert.equal(link.searchParams.get("load"), "38000");
    assert.equal(link.searchParams.get("scenario"), "storm-on-fastest");
  });

  test("every link departs inside [now - 15 min, now + 120 h], also for a clock with an offset", async () => {
    for (const now of [
      "2026-10-24T05:30:00Z",
      "2026-10-24T10:30:00+05:00",
      "2027-01-01T00:00:30Z",
    ]) {
      const res = await runStack(["env"], {
        STACK_REPLAY_NOW: now,
        STACK_STATE_DIR: await makeDirectory("stack-state-"),
      });
      const values = parseEnvLines(res.stdout);
      const clock = Date.parse(values.HAULCAST_REPLAY_NOW);

      assert.equal(values.HAULCAST_REPLAY_NOW, now);
      for (const [name, value] of Object.entries(values)) {
        if (!name.startsWith("STACK_LINK_")) continue;
        const depart = Date.parse(new URL(value).searchParams.get("depart"));
        assert.ok(depart >= clock - 15 * 60_000, `${name} departs too early for ${now}`);
        assert.ok(depart <= clock + 120 * 3_600_000, `${name} departs too late for ${now}`);
      }
    }
  });

  test("without STACK_REPLAY_NOW the clock is the current minute", async () => {
    const before = Date.now();

    const res = await runStack(["env"], { STACK_STATE_DIR: await makeDirectory("stack-state-") });

    const clock = parseEnvLines(res.stdout).HAULCAST_REPLAY_NOW;
    assert.match(clock, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    assert.ok(Math.abs(Date.parse(clock) - before) < 120_000, clock);
  });

  test("a stack that is up reports the clock it was started with, not a new one", async () => {
    const state = await makeDirectory("stack-state-");
    const gateway = await freePort();
    const pid = await startServiceLikeUp(gateway);
    await writeFile(path.join(state, "gateway.pid"), `${pid}\n`);
    await writeFile(path.join(state, "env"), "HAULCAST_REPLAY_NOW=2026-10-20T13:40:00Z\n");

    const res = await runStack(["env"], {
      STACK_GATEWAY_PORT: String(gateway),
      STACK_REPLAY_NOW: "2026-12-01T00:00:00Z",
      STACK_STATE_DIR: state,
    });

    assert.equal(parseEnvLines(res.stdout).HAULCAST_REPLAY_NOW, "2026-10-20T13:40:00Z");
  });
});

describe("stack.sh up refuses what cannot work", () => {
  test("a port that is already in use stops it before anything is started", async () => {
    const state = await makeDirectory("stack-state-");
    const blocker = http.createServer();
    const taken = await listen(blocker);

    const res = await runStack(["up"], {
      STACK_GATEWAY_PORT: String(taken),
      STACK_DJANGO_PORT: String(await freePort()),
      STACK_STATE_DIR: state,
      STACK_CLIENT_DIR: await makeDirectory("stack-client-"),
    });

    assert.equal(res.status, 1);
    assert.match(res.stderr, new RegExp(`port ${taken} is already in use`));
    assert.deepEqual(await readdir(state), []);
  });

  test("a missing production build stops it before the database is touched", async () => {
    const state = await makeDirectory("stack-state-");

    const res = await runStack(["up"], {
      STACK_GATEWAY_PORT: String(await freePort()),
      STACK_DJANGO_PORT: String(await freePort()),
      STACK_STATE_DIR: state,
      STACK_CLIENT_DIR: await makeDirectory("stack-client-"),
      STACK_DATABASE_URL: `postgresql://postgres@127.0.0.1:${await freePort()}/postgres`,
    });

    assert.equal(res.status, 1);
    assert.match(res.stderr, /not a frontend production build.*pnpm build/);
    assert.deepEqual(await readdir(state), []);
  });
});

/** The PATH variable under the name this platform gives it, with `directory` in front. */
function pathWith(directory) {
  const name = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
  return { [name]: `${directory}${path.delimiter}${process.env[name]}` };
}

/**
 * Stand-ins for the two tools `up` runs before it starts anything: a `psql` that finds the stack
 * database, and a `uv` that records the DATABASE_URL it was given (into the file that
 * MIGRATION_RECORD names) and fails, which ends `up` at its migration step.
 */
async function writeFakeTools() {
  const bin = await makeDirectory("stack-tools-");
  await writeFile(`${bin}/psql`, "#!/usr/bin/env bash\necho 1\n", { mode: 0o755 });
  await writeFile(
    `${bin}/uv`,
    "#!/usr/bin/env bash\nprintf '%s' \"$DATABASE_URL\" >\"$MIGRATION_RECORD\"\nexit 1\n",
    { mode: 0o755 },
  );
  return { bin, record: `${bin}/database-url-the-migration-saw` };
}

/** The settings of an `up` that can get as far as the database: a build to serve and the fakes. */
async function settingsForUp(administratorDsn, tools) {
  const client = await makeDirectory("stack-client-");
  await writeFile(`${client}/__spa-fallback.html`, "<!doctype html>");
  return {
    ...(await freeSettings()),
    STACK_CLIENT_DIR: client,
    STACK_DATABASE_URL: administratorDsn,
    MIGRATION_RECORD: tools.record,
    ...pathWith(tools.bin),
  };
}

describe("stack.sh up hands its settings to the shell exactly", () => {
  /** `up` against a listening socket that stands in for Postgres, as far as its migration step. */
  async function upUntilTheMigration(userInfo) {
    const serverPort = await listen(http.createServer());
    const tools = await writeFakeTools();
    const dsn = `postgresql://${userInfo}@127.0.0.1:${serverPort}/postgres`;
    const res = await runStack(["up"], await settingsForUp(dsn, tools));
    const saw = await readFile(tools.record, "utf8").catch(() => undefined);
    return { res, saw, serverPort };
  }

  test("a plain administrator DSN reaches the migration step as given, with the stack database", async () => {
    const { res, saw, serverPort } = await upUntilTheMigration("postgres");

    assert.equal(res.status, 1);
    assert.match(res.stderr, /the bootstrap or the migrations failed/);
    assert.equal(saw, `postgresql://postgres@127.0.0.1:${serverPort}/haulcast_stack`);
  });

  test("a DSN password made of characters that mean something to the shell arrives untouched", async () => {
    const metacharacters = "a$$b&c;(d) 'e\"f#*\\g";
    const { res, saw, serverPort } = await upUntilTheMigration(`postgres:${metacharacters}`);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /the bootstrap or the migrations failed/);
    assert.equal(
      saw,
      `postgresql://postgres:${metacharacters}@127.0.0.1:${serverPort}/haulcast_stack`,
      `the migration step saw ${JSON.stringify(saw)}; up said: ${res.stderr}`,
    );
  });
});

describe("stack.sh down, status, logs and reset", () => {
  test("down stops the services it started, by pid, and nothing else", async () => {
    const state = await makeDirectory("stack-state-");
    const [gateway, django, other] = [await freePort(), await freePort(), await freePort()];
    await writeFile(path.join(state, "gateway.pid"), `${await startServiceLikeUp(gateway)}\n`);
    await writeFile(path.join(state, "django.pid"), `${await startServiceLikeUp(django)}\n`);
    const bystander = await startBystander(other);

    const res = await runStack(["down"], {
      STACK_GATEWAY_PORT: String(gateway),
      STACK_DJANGO_PORT: String(django),
      STACK_STATE_DIR: state,
    });

    assert.equal(res.status, 0, res.stderr);
    await waitForPort(gateway, false);
    await waitForPort(django, false);
    assert.equal(await canConnect(other), true, "a process of the same name must survive");
    assert.equal(bystander.exitCode, null);
    assert.deepEqual(await readdir(state), []);
    assert.match(res.stdout, /stopped gateway/);
    assert.match(res.stdout, /stopped django/);
  });

  test("down with nothing running succeeds and says so", async () => {
    const res = await runStack(["down"], await freeSettings());

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /nothing to stop/);
  });

  test("down drops the pid file of a service that is already gone", async () => {
    const settings = await freeSettings();
    await writeFile(path.join(settings.STACK_STATE_DIR, "django.pid"), "999999\n");

    const res = await runStack(["down"], settings);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /django was not running/);
    assert.deepEqual(await readdir(settings.STACK_STATE_DIR), []);
  });

  test("down leaves alone a process that only has the pid of a vanished service", async () => {
    const settings = await freeSettings();
    const innocentPort = await freePort();
    const innocent = await startServiceLikeUp(innocentPort);
    await writeFile(path.join(settings.STACK_STATE_DIR, "gateway.pid"), `${innocent}\n`);

    const res = await runStack(["down"], settings);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /gateway was not running/);
    assert.equal(await canConnect(innocentPort), true, "the process that reuses the pid must live");
    assert.deepEqual(await readdir(settings.STACK_STATE_DIR), []);
  });

  test("down fails loudly when a port is still held after the services are stopped", async () => {
    const holder = http.createServer();
    const port = await listen(holder);

    const res = await runStack(["down"], {
      STACK_GATEWAY_PORT: String(port),
      STACK_STATE_DIR: await makeDirectory("stack-state-"),
    });

    assert.equal(res.status, 1);
    assert.match(res.stderr, new RegExp(`port ${port} is still in use`));
  });

  test("status reports stopped services with exit code 3", async () => {
    const res = await runStack(["status"], await freeSettings());

    assert.equal(res.status, 3);
    assert.match(res.stdout, /gateway: stopped/);
    assert.match(res.stdout, /django: stopped/);
  });

  test("status reports running services with their pid and URL", async () => {
    const state = await makeDirectory("stack-state-");
    const [gateway, django] = [await freePort(), await freePort()];
    const gatewayPid = await startServiceLikeUp(gateway);
    const djangoPid = await startServiceLikeUp(django);
    await writeFile(path.join(state, "gateway.pid"), `${gatewayPid}\n`);
    await writeFile(path.join(state, "django.pid"), `${djangoPid}\n`);

    const res = await runStack(["status"], {
      STACK_GATEWAY_PORT: String(gateway),
      STACK_DJANGO_PORT: String(django),
      STACK_STATE_DIR: state,
    });

    assert.equal(res.status, 0, res.stderr);
    assert.match(
      res.stdout,
      new RegExp(`gateway: running \\(pid ${gatewayPid}\\) http://127\\.0\\.0\\.1:${gateway}`),
    );
    assert.match(
      res.stdout,
      new RegExp(`django: running \\(pid ${djangoPid}\\) http://127\\.0\\.0\\.1:${django}`),
    );
  });

  test("status calls a service whose pid is alive but whose port is closed not running", async () => {
    const state = await makeDirectory("stack-state-");
    const alive = await startServiceLikeUp(await freePort());
    await writeFile(path.join(state, "gateway.pid"), `${alive}\n`);

    const res = await runStack(["status"], {
      STACK_GATEWAY_PORT: String(await freePort()),
      STACK_STATE_DIR: state,
    });

    assert.equal(res.status, 3);
    assert.match(res.stdout, /gateway: not answering/);
  });

  test("logs prints the log of one service or of both", async () => {
    const state = await makeDirectory("stack-state-");
    await writeFile(path.join(state, "django.log"), "django line one\ndjango line two\n");
    await writeFile(path.join(state, "gateway.log"), "gateway line\n");

    const one = await runStack(["logs", "django"], { STACK_STATE_DIR: state });
    const both = await runStack(["logs"], { STACK_STATE_DIR: state });

    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /django line one\ndjango line two/);
    assert.doesNotMatch(one.stdout, /gateway line/);
    assert.match(
      both.stdout,
      /==> django <==\ndjango line one[\s\S]*==> gateway <==\ngateway line/,
    );
  });

  test("logs without logs, or for a service that does not exist, is an error", async () => {
    const state = await makeDirectory("stack-state-");

    const none = await runStack(["logs"], { STACK_STATE_DIR: state });
    const unknown = await runStack(["logs", "postgres"], { STACK_STATE_DIR: state });

    assert.equal(none.status, 1);
    assert.match(none.stderr, /no logs/);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /usage: .*logs \[django\|gateway\]/);
  });

  test("reset forgets the state even when the database server is not there", async () => {
    const settings = await freeSettings();
    const state = settings.STACK_STATE_DIR;
    await writeFile(path.join(state, "env"), "DJANGO_SECRET_KEY=throwaway\n");
    await writeFile(path.join(state, "django.log"), "log\n");

    const res = await runStack(["reset"], {
      ...settings,
      STACK_DATABASE_URL: `postgresql://postgres@127.0.0.1:${await freePort()}/postgres`,
    });

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /database server is not running/);
    await assert.rejects(readdir(state), /ENOENT/);
  });
});

describe("stack.sh smoke", () => {
  const PLAN = {
    plan_id: "p1",
    routes: [
      { route_id: "A", duration_s: 1000 },
      { route_id: "B", duration_s: 1200 },
      { route_id: "C", duration_s: 1500 },
    ],
    recommendation: { route_id: "C", status: "ok" },
  };
  const SCENARIOS = ["calm", "storm-on-fastest", "high-wind-corridor", "gulf-downpour"];

  /** What a healthy stack answers; a test replaces single routes to break one thing. */
  const healthy = () => {
    let created = false;
    const plansPerClient = new Map();
    return {
      "GET /": () => ({ type: "text/html", body: "<!doctype html><title>Haulcast</title>" }),
      "GET /api/v1/health": () => ({ body: { status: "ok", version: "0", commit: "x" } }),
      "GET /api/v1/health/ready": () => ({ body: { status: "ok", database: "ok" } }),
      "GET /api/v1/geocode": () => ({
        body: { query: "q", results: [{ name: "Salt Lake City" }] },
      }),
      "GET /api/v1/scenarios": () => ({ body: SCENARIOS.map((id) => ({ id, name: id })) }),
      "POST /api/v1/plans": (req) => {
        // The real limiter: 6 plans a minute for each client, told apart by x-forwarded-for.
        const client = req.headers["x-forwarded-for"] ?? "unknown";
        const taken = (plansPerClient.get(client) ?? 0) + 1;
        plansPerClient.set(client, taken);
        if (taken > 6) return { status: 429, body: { code: "rate_limited" } };
        const status = created ? 200 : 201;
        created = true;
        return { status, body: PLAN };
      },
      "GET /api/v1/plans/p1/heatmap": () => ({ body: { plan_id: "p1", frame_count: 49 } }),
    };
  };

  async function runSmoke(routes) {
    const seen = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const route = `${req.method} ${new URL(req.url, "http://stack.test").pathname}`;
        seen.push({ route, headers: req.headers });
        const answer = routes[route]?.(req) ?? { status: 404, body: { code: "not_found" } };
        const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
        res.writeHead(answer.status ?? 200, { "content-type": answer.type ?? "application/json" });
        res.end(body);
      });
    });
    const port = await listen(server);
    const result = await runStack(["smoke"], {
      STACK_GATEWAY_PORT: String(port),
      STACK_REPLAY_NOW: "2026-10-24T05:30:00Z",
      STACK_STATE_DIR: await makeDirectory("stack-state-"),
    });
    return { ...result, seen };
  }

  test(
    "a healthy stack passes, and the same stack passes a second time",
    { timeout: 120_000 },
    async () => {
      const routes = healthy();

      const first = await runSmoke(routes);
      const second = await runSmoke(routes);

      assert.equal(first.status, 0, first.stderr);
      assert.equal(second.status, 0, second.stderr);
      assert.match(first.stdout, /smoke: all checks passed/);
    },
  );

  test(
    "it plans Salt Lake City to Denver on storm-on-fastest and sends the gateway's Origin",
    { timeout: 120_000 },
    async () => {
      const posts = [];
      const routes = healthy();
      const plan = routes["POST /api/v1/plans"];
      routes["POST /api/v1/plans"] = (req) => {
        posts.push(req.headers);
        return plan(req);
      };

      const res = await runSmoke(routes);

      assert.equal(res.status, 0, res.stderr);
      assert.equal(posts[0].origin, undefined);
      assert.match(posts[1].origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(posts[0]["x-forwarded-for"], /^10\.\d+\.\d+\.\d+$/);
      assert.equal(posts[0]["content-type"], "application/json");
      const clients = new Set(posts.map((headers) => headers["x-forwarded-for"]));
      assert.equal(
        clients.size,
        3,
        "the plan's client, the client that is limited, and another one",
      );
    },
  );

  test(
    "each thing that can be wrong with a stack fails the smoke, by name",
    { timeout: 300_000 },
    async () => {
      const broken = (route, answer, message) => ({ route, answer, message });
      const cases = [
        broken("GET /", () => ({ status: 404, body: "no" }), /front page/),
        broken("GET /api/v1/health", () => ({ status: 500, body: {} }), /health: .*500/),
        broken(
          "GET /api/v1/health/ready",
          () => ({ body: { status: "ok", database: "down" } }),
          /ready/,
        ),
        broken(
          "GET /api/v1/geocode",
          () => ({ body: { results: [{ name: "Salt Lake, Hawaii" }] } }),
          /geocode/,
        ),
        broken("GET /api/v1/scenarios", () => ({ body: [{ id: "calm" }] }), /scenarios/),
        broken("POST /api/v1/plans", () => ({ status: 422, body: { code: "x" } }), /plan: .*422/),
        broken(
          "POST /api/v1/plans",
          () => ({ status: 201, body: { ...PLAN, routes: PLAN.routes.slice(0, 2) } }),
          /3 routes/,
        ),
        broken(
          "POST /api/v1/plans",
          () => ({
            status: 201,
            body: { ...PLAN, recommendation: { route_id: "A", status: "ok" } },
          }),
          /not the fastest/,
        ),
        broken(
          "POST /api/v1/plans",
          (req) =>
            req.headers.origin ? { status: 403, body: { code: "origin_not_allowed" } } : undefined,
          /Origin/,
        ),
        broken("GET /api/v1/plans/p1/heatmap", () => ({ body: { frame_count: 48 } }), /49 frames/),
        // x-forwarded-for does not reach Django as sent (waitress deletes it unless it is told not to):
        // every client lands in one bucket, and the second client is limited as well.
        broken(
          "POST /api/v1/plans",
          (() => {
            let seen = 0;
            return () =>
              (seen += 1) > 6 ? { status: 429, body: { code: "rate_limited" } } : undefined;
          })(),
          /x-forwarded-for does not reach Django/,
        ),
        // A limiter that never says no: the burst of one client is not limited.
        broken("POST /api/v1/plans", () => ({ status: 200, body: PLAN }), /never limited/),
      ];

      for (const { route, answer, message } of cases) {
        const routes = healthy();
        const fallback = routes[route];
        routes[route] = (req) => answer(req) ?? fallback(req);

        const res = await runSmoke(routes);

        assert.equal(res.status, 1, `${route} ${message}: ${res.stdout}`);
        assert.match(res.stderr, message, route);
      }
    },
  );

  test(
    "a stack that is down fails the smoke instead of hanging",
    { timeout: 120_000 },
    async () => {
      const res = await runStack(["smoke"], {
        STACK_GATEWAY_PORT: String(await freePort()),
        STACK_REPLAY_NOW: "2026-10-24T05:30:00Z",
        STACK_STATE_DIR: await makeDirectory("stack-state-"),
      });

      assert.equal(res.status, 1);
      assert.match(res.stderr, /smoke: FAIL/);
    },
  );
});
