#!/usr/bin/env bash
# Runs a command inside Xvfb with the X pointer parked outside every window, and proves it stayed
# there (D-41, D-42). CI only: the Firefox projects run headed inside Xvfb (D-40), and Xvfb starts its
# pointer at the centre of the screen, inside the browser window. A window that maps or grows under
# a still pointer gets real crossing and motion events, and those end Playwright's synthetic hover.
#
#   E2E_FIREFOX_XVFB=1 bash scripts/e2e-xvfb.sh <command> [args...]
#
# The server runs with -noreset (D-42). An X server resets when its last client disconnects, and a
# reset puts the pointer back at the screen centre. A one-shot client such as one xdotool call is the
# last client while it runs alone, so without -noreset its exit undoes its own move: the park holds
# inside xdotool and reads as the centre from the next process (CI run 39629386862 shows it).
#
# Before any browser starts, the pointer goes to the screen's far corner (read from the server, not
# assumed), and the park is checked from a new process; the check also proves that no client window
# exists yet and that the window under the park point is the root window. While the command runs, a
# watcher samples the pointer every 200 ms; a pointer that moved, or a window that covers the park
# point, is a violation.
# Any violation, or a watcher that died early, fails the run even when the command passed. Otherwise
# the script exits with the command's own status. The log names the server and its extensions, the
# tool and the park, and shows the window tree once a browser window exists (D-42).
set -euo pipefail

# The screen: 24-bit, as GL needs. If a browser window ever covers the far corner, enlarge it here;
# never relax the watcher (D-41).
readonly XVFB_SCREEN="1920x1080x24"
# -noreset keeps the server, and with it the parked pointer, when the last client disconnects (D-42).
readonly XVFB_SERVER_ARGS="-screen 0 ${XVFB_SCREEN} -noreset"
readonly SAMPLE_INTERVAL_SECONDS="0.2"

error() {
  echo "::error::e2e-xvfb (D-41): $*" >&2
}

log() {
  echo "e2e-xvfb (D-42): $*"
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
# xdpyinfo and xwininfo (package x11-utils) are the log's eyes on the server and its windows (D-42).
for tool in xvfb-run xdotool xdpyinfo xwininfo; do
  if ! command -v "$tool" > /dev/null; then
    error "$tool is missing"
    exit 1
  fi
done

if [ "$1" != "--inside-xvfb" ]; then
  exec xvfb-run --auto-servernum --server-args="${XVFB_SERVER_ARGS}" \
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

# What this step runs on, once per Xvfb step (D-42): the server's argv and extensions, the tool, the
# screen.
log "Xvfb: $(ps -o args= -C Xvfb | grep -F -- "Xvfb ${DISPLAY:-unset} " | head -n 1)"
log "DISPLAY=${DISPLAY:-unset}; screen ${width}x${height}; $(xdotool version 2>&1 | head -n 1)"
log "extensions of the server (xdpyinfo -queryExtensions):"
xdpyinfo -queryExtensions 2>&1 | grep -E '^(number of extensions|vendor string|version number)|\(opcode: ' |
  sed 's/^/  /' || true

# The park: xdotool mousemove puts the pointer at the far corner. The check polls briefly and reads
# from a new process each time, because that is what shows a reset, or a move that did not stick.
park_polls=0
parked() {
  local attempt
  for attempt in $(seq 1 20); do
    if read_pointer && [ "$POINTER_X" = "$PARK_X" ] && [ "$POINTER_Y" = "$PARK_Y" ]; then
      park_polls="$attempt"
      return 0
    fi
    sleep 0.1
  done
  return 1
}
if read_pointer; then
  log "the pointer starts at X=${POINTER_X} Y=${POINTER_Y}"
fi
if ! moved="$(timeout 5 xdotool mousemove "$PARK_X" "$PARK_Y" 2>&1)"; then
  error "xdotool mousemove ${PARK_X} ${PARK_Y} failed: ${moved:-timed out}"
  exit 1
fi
if ! parked; then
  error "the pointer is at ${POINTER_X:-?},${POINTER_Y:-?}, not at the park point ${PARK_X},${PARK_Y}." \
    "An X server resets when its last client disconnects, and a reset puts the pointer back at the" \
    "centre: the server must run with -noreset (D-42)."
  exit 1
fi
# D-41 relies on two facts at the start: no client window exists yet, and nothing covers the park
# point. Prove them, do not assume them: the root window must have 0 children, and the window under
# the pointer must be the root window (xwininfo prints its id in hex, xdotool in decimal).
if ! root_tree="$(xwininfo -root -children 2>&1)"; then
  error "xwininfo -root -children failed: ${root_tree}"
  exit 1
fi
root_id_pattern='Window id: (0x[0-9a-fA-F]+)'
no_children_pattern='[[:space:]]0 children\.'
if [[ ! "$root_tree" =~ $root_id_pattern ]]; then
  error "xwininfo -root -children gave no root window id: $(tr '\n' ' ' <<< "$root_tree")"
  exit 1
fi
root_id=$((BASH_REMATCH[1]))
if [ "$POINTER_WINDOW" != "$root_id" ]; then
  error "the window under the park point is ${POINTER_WINDOW}, not the root window ${root_id}:" \
    "a window already covers it"
  exit 1
fi
if [[ ! "$root_tree" =~ $no_children_pattern ]]; then
  error "a client window exists before the park is proven, so the park point may be covered:" \
    "$(tr '\n' ' ' <<< "$root_tree")"
  exit 1
fi
readonly ROOT_WINDOW="$root_id"
log "pointer parked at X=${PARK_X} Y=${PARK_Y}, read back from a new process after ${park_polls}" \
  "poll(s); the window under it is the root window ${ROOT_WINDOW}, which has 0 children"

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

# Logs the window tree once, after the first client window exists and has settled (D-42). It only
# informs: the watcher above is what fails the step.
log_windows_once() {
  local window
  local -a windows
  set +e
  until [[ "$(xwininfo -root -children 2> /dev/null)" =~ [[:space:]][1-9][0-9]*[[:space:]]child ]]; do
    sleep "$SAMPLE_INTERVAL_SECONDS"
  done
  sleep 2
  log "the window tree once a client window exists (xwininfo -root -tree):"
  xwininfo -root -tree 2>&1 | sed 's/^/  /'
  log "the visible windows and the pointer:"
  mapfile -t windows < <(xdotool search --onlyvisible --class "." 2> /dev/null)
  for window in "${windows[@]}"; do
    echo "  window ${window}: $(xdotool getwindowname "$window" 2>&1)" \
      "$(xdotool getwindowgeometry "$window" 2>&1 | tr '\n' ' ')"
  done
  echo "  pointer: $(xdotool getmouselocation --shell 2>&1 | tr '\n' ' ')"
}

cleanup() {
  kill "${watcher:-}" "${tree_logger:-}" 2> /dev/null || true
}
trap cleanup EXIT

watch_pointer &
watcher=$!
log_windows_once &
tree_logger=$!

set +e
"$@"
status=$?
set -e

watcher_alive=true
if ! kill -0 "$watcher" 2> /dev/null; then
  watcher_alive=false
fi
cleanup
wait "$watcher" "$tree_logger" 2> /dev/null || true

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
