import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPreviewServer, DEFAULT_PORT, explainServerError, parsePort } from "./server.ts";

describe("parsePort", () => {
  it("uses the default port when none is given", () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(4201);
  });

  it.each(["1", "4211", "65535"])("accepts %s", (value) => {
    expect(parsePort(value)).toBe(Number(value));
  });

  it.each(["", "0", "65536", "-1", "42.5", "abc", "4211abc", " "])(
    'refuses "%s" and says what E2E_PORT must be',
    (value) => {
      expect(() => parsePort(value)).toThrow(`E2E_PORT must be a port number, got "${value}".`);
    },
  );
});

describe("explainServerError", () => {
  const failure = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`boom ${code}`), { code });

  it("says a taken port is refused, never moved away from", () => {
    expect(explainServerError(failure("EADDRINUSE"), 4211)).toBe(
      "Port 4211 is already in use; refusing to serve on another port.",
    );
  });

  it("passes any other failure on with its own message", () => {
    expect(explainServerError(failure("EACCES"), 4211)).toBe("Preview server failed: boom EACCES");
  });
});

describe("createPreviewServer", () => {
  let directory = "";
  let server: Server | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "preview-"));
    writeFileSync(join(directory, "index.html"), "<p>index</p>");
    writeFileSync(join(directory, "__spa-fallback.html"), "<p>fallback</p>");
    writeFileSync(join(directory, "app.js"), "export {};");
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
      } else {
        server.close(() => {
          resolve();
        });
      }
    });
    server = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  /** Listens on a free port of this machine and returns it. */
  async function listen(created: Server, port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      created.once("error", reject);
      created.listen(port, "127.0.0.1", resolve);
    });
    const address = created.address();
    if (address === null || typeof address === "string") {
      throw new Error("the preview server has no port");
    }
    return address.port;
  }

  it("serves the files of the build", async () => {
    server = createPreviewServer(directory);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${String(port)}/app.js`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export {};");
  });

  it("falls back to the SPA shell for a client route, as Vercel does", async () => {
    server = createPreviewServer(directory);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${String(port)}/design`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>fallback</p>");
  });

  it("refuses a port that is taken instead of moving to another one", async () => {
    server = createPreviewServer(directory);
    const port = await listen(server);
    const second = createPreviewServer(directory);

    await expect(listen(second, port)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
