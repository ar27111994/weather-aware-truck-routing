// Tests for scripts/lighthouse-bypass.cjs: the puppeteerScript that lets Lighthouse CI reach a
// protected Vercel preview with the automation bypass secret without leaking it.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import bypass from "../lighthouse-bypass.cjs";

const SECRET = "s3cret-value-that-must-never-be-logged";
const PAGE_URL = "https://haulcast-git-feature-x-acme.vercel.app/methodology";

/** A recording stand-in for the puppeteer browser: only what the script uses. */
function fakeBrowser({ status = 200, response = undefined, gotoError = undefined } = {}) {
  const calls = { headers: [], gotos: [], closed: 0, pages: 0 };
  const page = {
    setExtraHTTPHeaders: async (headers) => calls.headers.push(headers),
    goto: async (url, options) => {
      calls.gotos.push({ url, options });
      if (gotoError) {
        throw gotoError;
      }
      return response === undefined ? { status: () => status } : response;
    },
    close: async () => {
      calls.closed += 1;
    },
  };
  return {
    calls,
    browser: {
      newPage: async () => {
        calls.pages += 1;
        return page;
      },
    },
  };
}

describe("lighthouse-bypass", () => {
  let previous;

  beforeEach(() => {
    previous = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = SECRET;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    } else {
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET = previous;
    }
  });

  test("does nothing without a secret (production, a public deployment)", async () => {
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const { browser, calls } = fakeBrowser();

    await bypass(browser, { url: PAGE_URL });

    assert.equal(calls.pages, 0);
  });

  test("does nothing for an empty secret (an unset repository secret expands to an empty string)", async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "";
    const { browser, calls } = fakeBrowser();

    await bypass(browser, { url: PAGE_URL });

    assert.equal(calls.pages, 0);
  });

  test("asks Vercel for a bypass cookie on a path the measurement does not load", async () => {
    const { browser, calls } = fakeBrowser();

    await bypass(browser, { url: PAGE_URL });

    assert.deepEqual(calls.headers, [
      { "x-vercel-protection-bypass": SECRET, "x-vercel-set-bypass-cookie": "true" },
    ]);
    assert.equal(calls.gotos.length, 1);
    assert.equal(calls.gotos[0].url, "https://haulcast-git-feature-x-acme.vercel.app/robots.txt");
  });

  test("closes the priming tab so Lighthouse measures in a fresh one", async () => {
    const { browser, calls } = fakeBrowser();

    await bypass(browser, { url: PAGE_URL });

    assert.equal(calls.closed, 1);
  });

  test("accepts any answer except a refusal: the priming path may well be a 404", async () => {
    for (const status of [200, 404, 500]) {
      const { browser } = fakeBrowser({ status });

      await bypass(browser, { url: PAGE_URL });
    }
  });

  test("fails loudly when Deployment Protection refuses the secret, without echoing it", async () => {
    for (const status of [401, 403]) {
      const { browser, calls } = fakeBrowser({ status });

      await assert.rejects(bypass(browser, { url: PAGE_URL }), (error) => {
        assert.match(error.message, /Deployment Protection/);
        assert.match(error.message, /VERCEL_AUTOMATION_BYPASS_SECRET/);
        assert.ok(!error.message.includes(SECRET));
        assert.match(error.message, new RegExp(String(status)));
        return true;
      });
      assert.equal(calls.closed, 1, "the tab is closed even when the check fails");
    }
  });

  test("fails loudly when the priming request produced no response", async () => {
    const { browser, calls } = fakeBrowser({ response: null });

    await assert.rejects(bypass(browser, { url: PAGE_URL }), /Deployment Protection/);
    assert.equal(calls.closed, 1);
  });

  test("closes the tab and propagates a navigation error", async () => {
    const { browser, calls } = fakeBrowser({ gotoError: new Error("net::ERR_NAME_NOT_RESOLVED") });

    await assert.rejects(bypass(browser, { url: PAGE_URL }), /ERR_NAME_NOT_RESOLVED/);
    assert.equal(calls.closed, 1);
  });
});
