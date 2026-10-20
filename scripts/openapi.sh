#!/usr/bin/env bash
# OpenAPI contract tooling. The Django Ninja schema is the source of truth; `shared/openapi.json` is
# its committed snapshot and the frontend's generated types derive from it.
#
# usage: scripts/openapi.sh export|check
#   export   regenerate shared/openapi.json from the backend (commit the result with the API change)
#   check    fail when the committed snapshot drifted from the backend, when the snapshot cannot be
#            turned into compiling TypeScript types, or when committed generated types are stale
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
readonly SCHEMA="shared/openapi.json"
# Where the frontend keeps its generated types. The check is enforced once the file exists.
readonly TYPES="frontend/app/api/schema.d.ts"
# A pinned CLI instead of a dependency: its TypeScript peer range (^5) conflicts with the app's
# TypeScript 6 (docs/CI-CD.md). Bump the version here only.
readonly OPENAPI_TYPESCRIPT="openapi-typescript@7.13.0"

# Native Windows tools need C:/-style paths; on Linux the path passes through unchanged.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# The tools below run inside backend/ or frontend/, so every path they get must be absolute.
absolute() {
  printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"
}

fail() {
  echo "openapi: $*" >&2
  exit 1
}

# generate_schema OUTPUT_FILE
generate_schema() {
  uv run --directory backend python manage.py export_openapi_schema \
    --api haulcast.api.app.api --indent 2 --output "$(native "$(absolute "$1")")"
}

# generate_types SCHEMA_FILE OUTPUT_FILE
generate_types() {
  pnpm --dir frontend dlx "$OPENAPI_TYPESCRIPT" "$(native "$(absolute "$1")")" \
    -o "$(native "$(absolute "$2")")" >/dev/null
}

check() {
  # Not `local`: the EXIT trap runs after this function returns, when a local would be unset.
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp:-}"' EXIT

  [ -f "$SCHEMA" ] || fail "$SCHEMA is missing: run 'pnpm run openapi:export' and commit it"
  generate_schema "$tmp/openapi.json"
  diff -u "$SCHEMA" "$tmp/openapi.json" ||
    fail "$SCHEMA is stale: run 'pnpm run openapi:export' and commit the result"

  generate_types "$SCHEMA" "$tmp/schema.d.ts"
  pnpm --dir frontend exec tsc --noEmit --strict --target ES2023 --module esnext \
    --moduleResolution bundler --ignoreConfig "$(native "$tmp/schema.d.ts")" ||
    fail "the types generated from $SCHEMA do not compile"

  if [ -f "$TYPES" ]; then
    pnpm --dir frontend exec prettier --stdin-filepath schema.d.ts <"$tmp/schema.d.ts" >"$tmp/formatted.d.ts"
    cmp -s "$TYPES" "$tmp/schema.d.ts" || cmp -s "$TYPES" "$tmp/formatted.d.ts" ||
      fail "$TYPES is stale: regenerate it with '$OPENAPI_TYPESCRIPT $SCHEMA -o $TYPES'"
  else
    echo "openapi: $TYPES does not exist yet, so committed-types drift is not enforced (the schema and its generated types were still checked)"
  fi
  echo "openapi: schema snapshot and generated types are up to date"
}

case "${1:-}" in
  export) generate_schema "$SCHEMA" ;;
  check) check ;;
  *)
    echo "usage: scripts/openapi.sh export|check" >&2
    exit 2
    ;;
esac
