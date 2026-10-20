// Run by `lhci collect --puppeteerScript` before every Lighthouse run against a deployed site (see
// .github/workflows/lighthouse.yml). A Vercel preview stays protected (Vercel Authentication) and
// answers 401 until the request carries the automation bypass secret. This script sends the secret
// once, in a tab the measurement never uses, and asks Vercel to answer with a bypass cookie; the
// cookie then authenticates the browser for the Lighthouse run that follows.
//
// Why a cookie and not Lighthouse's `extraHeaders`: extra headers go to EVERY request of the page,
// including third-party ones (map tiles), and are written into the saved Lighthouse report. The
// cookie is scoped to the deployment's host and never appears in a report. Lighthouse clears the
// HTTP cache, service workers and cache storage before each run but, by default, not cookies, so
// the measured load is still cold.
//
// The secret is read from VERCEL_AUTOMATION_BYPASS_SECRET and never printed. Without it (production,
// a public deployment) the script does nothing.
"use strict";

// A path the measurement does not load: whatever it answers, the cookie is set on the response.
const PRIMING_PATH = "/robots.txt";
const REJECTED = new Set([401, 403]);

/**
 * @param {import("puppeteer-core").Browser} browser the browser Lighthouse will drive next
 * @param {{ url: string }} context the page about to be measured
 * @returns {Promise<void>}
 */
module.exports = async (browser, { url }) => {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) {
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      "x-vercel-protection-bypass": secret,
      "x-vercel-set-bypass-cookie": "true",
    });
    const response = await page.goto(new URL(PRIMING_PATH, url).href, { waitUntil: "load" });
    const status = response === null ? 0 : response.status();
    if (response === null || REJECTED.has(status)) {
      throw new Error(
        `Vercel Deployment Protection refused the automation bypass secret (HTTP ${String(status)}); ` +
          "check VERCEL_AUTOMATION_BYPASS_SECRET against the project's Protection Bypass for Automation.",
      );
    }
  } finally {
    await page.close();
  }
};
