#!/usr/bin/env bash
# Build the Vercel deployment output, then harden and verify it (see scripts/vercel_output.py).
#
# usage: scripts/vercel-build.sh dry-run|preview|production
#   dry-run      no Vercel account needed: links a throw-away project and builds a preview. Used by
#                CI to prove that vercel.json, the Python function and the prerender all build.
#   preview      build with the project that `vercel pull` linked (preview environment)
#   production   the same with --prod
#
# Needs the Vercel CLI, Node/pnpm (frontend build) and uv (Python function) on PATH.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
mode="${1:-dry-run}"
case "$mode" in
  dry-run | preview | production) ;;
  *)
    echo "usage: scripts/vercel-build.sh dry-run|preview|production" >&2
    exit 2
    ;;
esac

# The Python builder derives these two files from api/requirements.txt on every build. A stale copy
# left by an earlier local build would silently win over a fresh export.
rm -f api/pyproject.toml api/uv.lock

if [ "$mode" = dry-run ]; then
  mkdir -p .vercel
  printf '%s\n' '{"projectId":"prj_dryrun0000","orgId":"team_dryrun0000","settings":{"framework":null,"devCommand":null,"installCommand":null,"buildCommand":null,"outputDirectory":null,"rootDirectory":null,"nodeVersion":"22.x","skipGitConnectDeployment":true}}' \
    >.vercel/project.json
fi

flags=(--yes)
if [ "$mode" = production ]; then
  flags+=(--prod)
fi
vercel build "${flags[@]}"

uv run --no-project python scripts/vercel_output.py inject-csp .vercel/output
uv run --no-project python scripts/vercel_output.py verify .vercel/output
