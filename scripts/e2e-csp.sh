#!/usr/bin/env bash
# Prove that the pages hydrate under the Content-Security-Policy the Vercel build produces.
#
# usage: scripts/e2e-csp.sh [playwright test arguments]
#        (run `scripts/vercel-build.sh dry-run` first; E2E_PORT=4301 picks another port)
#
# `vercel build` plus `scripts/vercel_output.py inject-csp` leave `.vercel/output` with the headers
# of production, the hashes of every inline script included. This serves that directory the way
# Vercel does (scripts/serve-vercel-output.mjs) and runs frontend/e2e/csp.spec.ts against it, so
# each browser enforces the real policy on the real pages. Without arguments it runs Chromium,
# Firefox and WebKit; arguments replace that default, for example `--project=csp-webkit --workers=1`.
#
# Needs the Playwright browsers installed (`pnpm exec playwright install chromium firefox webkit`
# in frontend/) and curl on PATH.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
output=".vercel/output"
port="${E2E_PORT:-4201}"
url="http://127.0.0.1:${port}"

if [ ! -f "${output}/config.json" ]; then
  echo "${output}/config.json is missing: run scripts/vercel-build.sh dry-run first" >&2
  exit 2
fi

node scripts/serve-vercel-output.mjs --dir "${output}" --port "${port}" &
server=$!
trap 'kill "${server}" 2>/dev/null || true' EXIT

# Wait for the server, and stop at once if it exits (a taken port, an unreadable output).
ready=false
for _ in $(seq 1 60); do
  if curl --silent --fail "${url}/" >/dev/null; then
    ready=true
    break
  fi
  if ! kill -0 "${server}" 2>/dev/null; then
    echo "scripts/serve-vercel-output.mjs exited before it was ready" >&2
    exit 1
  fi
  sleep 0.5
done
if [ "${ready}" != true ]; then
  echo "${url}/ did not answer within 30 seconds" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- --project=csp-chromium --project=csp-firefox --project=csp-webkit
fi
cd frontend
E2E_CSP=1 E2E_BASE_URL="${url}" pnpm exec playwright test "$@"
