#!/usr/bin/env bash
# Runs a command inside Xvfb with the X pointer parked outside every window, and proves it stayed
# there (D-41). CI only: the Firefox projects run headed inside Xvfb (D-40), and Xvfb starts its
# pointer at the centre of the screen, inside the browser window. A window that maps or grows under
# a still pointer gets real crossing and motion events, and those end Playwright's synthetic hover.
#
#   E2E_FIREFOX_XVFB=1 bash scripts/e2e-xvfb.sh <command> [args...]
#
# Before any browser starts, the pointer goes to the screen's far corner (read from the server, not
# assumed), and the park is checked. While the command runs, a watcher samples the pointer every
# 200 ms; a pointer that moved, or a window that covers the park point, is a violation. Any
# violation, or a watcher that died early, fails the run even when the command passed. Otherwise the
# script exits with the command's own status.
set -euo pipefail

# The screen: 24-bit, as GL needs. If a browser window ever covers the far corner, enlarge it here;
# never relax the watcher (D-41).
readonly XVFB_SCREEN="1920x1080x24"
readonly SAMPLE_INTERVAL_SECONDS="0.2"

error() {
  echo "::error::e2e-xvfb (D-41): $*" >&2
}

if [ "${CI:-}" = "" ] || [ "$(uname -s)" != "Linux" ] || [ "${E2E_FIREFOX_XVFB:-}" != "1" ]; then
  echo "e2e-xvfb.sh parks and watches the X pointer of a headed browser inside Xvfb. It runs only" \
    "on the Linux CI runner with E2E_FIREFOX_XVFB=1 (D-41), so it never moves the pointer of a" \
    "developer's desktop. Elsewhere, run the browsers headless (without E2E_FIREFOX_XVFB)." >&2
  exit 1
fi
if [ "$#" -eq 0 ]; then
  error "usage: E2E_FIREFOX_XVFB=1 bash scripts/e2e-xvfb.sh <command> [args...]"
  exit 1
fi
for tool in xvfb-run xdotool; do
  if ! command -v "$tool" > /dev/null; then
    error "$tool is missing"
    exit 1
  fi
done

if [ "$1" != "--inside-xvfb" ]; then
  exec xvfb-run --auto-servernum --server-args="-screen 0 ${XVFB_SCREEN}" \
    bash "${BASH_SOURCE[0]}" --inside-xvfb "$@"
fi
shift

# Reads `xdotool getmouselocation --shell` into POINTER_X, POINTER_Y and POINTER_WINDOW.
read_pointer() {
  local output key value
  output="$(xdotool getmouselocation --shell 2>&1)" || {
    echo "xdotool getmouselocation failed: ${output}"
    return 1
  }
  POINTER_X="" POINTER_Y="" POINTER_WINDOW=""
  while IFS="=" read -r key value; do
    case "$key" in
      X) POINTER_X="$value" ;;
      Y) POINTER_Y="$value" ;;
      WINDOW) POINTER_WINDOW="$value" ;;
    esac
  done <<< "$output"
  if [ -z "$POINTER_X" ] || [ -z "$POINTER_Y" ] || [ -z "$POINTER_WINDOW" ]; then
    echo "xdotool getmouselocation gave no X, Y or WINDOW: ${output}"
    return 1
  fi
}

if ! display="$(xdotool getdisplaygeometry 2>&1)"; then
  error "could not read the screen size: ${display}"
  exit 1
fi
read -r width height <<< "$display"
readonly PARK_X=$((width - 1))
readonly PARK_Y=$((height - 1))
if ! moved="$(xdotool mousemove "$PARK_X" "$PARK_Y" 2>&1)"; then
  error "could not move the pointer to ${PARK_X},${PARK_Y}: ${moved}"
  exit 1
fi
if ! read_pointer; then
  error "could not read the pointer after parking it"
  exit 1
fi
if [ "$POINTER_X" != "$PARK_X" ] || [ "$POINTER_Y" != "$PARK_Y" ]; then
  error "the pointer is at ${POINTER_X},${POINTER_Y}, not at the park point ${PARK_X},${PARK_Y}"
  exit 1
fi
# No client window exists yet, so the window under the park point is the root window.
readonly ROOT_WINDOW="$POINTER_WINDOW"
echo "e2e-xvfb (D-41): screen ${width}x${height}; pointer parked at X=${PARK_X} Y=${PARK_Y}" \
  "on the root window ${ROOT_WINDOW}; $(xdotool version 2>&1 | head -n 1)"

state_dir="$(mktemp -d)"
readonly VIOLATIONS="${state_dir}/violations"
readonly SAMPLES="${state_dir}/samples"
: > "$VIOLATIONS"
: > "$SAMPLES"

watch_pointer() {
  local stamp geometry
  while :; do
    stamp="$(date -u +%H:%M:%S.%3N)"
    if ! read_pointer > "${state_dir}/read-error" 2>&1; then
      echo "${stamp} $(cat "${state_dir}/read-error")" >> "$VIOLATIONS"
    elif [ "$POINTER_X" != "$PARK_X" ] || [ "$POINTER_Y" != "$PARK_Y" ] ||
      [ "$POINTER_WINDOW" != "$ROOT_WINDOW" ]; then
      geometry="$(xdotool getwindowgeometry "$POINTER_WINDOW" 2>&1 | tr '\n' ' ' || true)"
      echo "${stamp} X=${POINTER_X} Y=${POINTER_Y} WINDOW=${POINTER_WINDOW} ${geometry}" >> "$VIOLATIONS"
    fi
    echo "$stamp" >> "$SAMPLES"
    sleep "$SAMPLE_INTERVAL_SECONDS"
  done
}

watch_pointer &
watcher=$!

set +e
"$@"
status=$?
set -e

watcher_alive=true
if ! kill -0 "$watcher" 2> /dev/null; then
  watcher_alive=false
fi
kill "$watcher" 2> /dev/null || true
wait "$watcher" 2> /dev/null || true

samples="$(wc -l < "$SAMPLES" | tr -d ' ')"
violations="$(wc -l < "$VIOLATIONS" | tr -d ' ')"
echo "e2e-xvfb (D-41): the watcher took ${samples} samples; ${violations} violations;" \
  "the command exited with ${status}"
if [ "$watcher_alive" = false ]; then
  error "the pointer watcher died before the command ended, so the park is unproven"
  exit 1
fi
if [ "$violations" != "0" ]; then
  while IFS= read -r line; do
    error "pointer off its park point or under a window: ${line}"
  done < "$VIOLATIONS"
  exit 1
fi
exit "$status"
