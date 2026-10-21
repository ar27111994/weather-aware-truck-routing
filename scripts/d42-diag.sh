#!/usr/bin/env bash
# TEMPORARY (D-42 diagnostic). Lives only on the throwaway branch ci/d41-probe; never merged.
# Question: why does the pointer read 960,540 after a park on the runner's Xvfb? Hypothesis: the X
# server RESETS when its last client disconnects (dispatchExceptionAtReset, xserver dix/dispatch.c),
# and a reset re-initialises the pointer at the screen centre. Every one-shot client (xdotool, or a
# one-shot python-xlib warp) is the last client, so its exit undoes its own move. `-noreset` (xserver
# os/utils.c) turns the reset off. Each experiment runs in its own Xvfb, with and without -noreset.
set -uo pipefail

if [ "${1:-}" != "--inside" ]; then
  out="${1:?usage: d42-diag.sh <output-dir>}"
  mkdir -p "$out"
  for mode in default noreset; do
    args="-screen 0 1920x1080x24"
    [ "$mode" = "noreset" ] && args="${args} -noreset"
    echo "##[group]Xvfb mode ${mode}: ${args}"
    xvfb-run --auto-servernum --server-args="${args}" bash "${BASH_SOURCE[0]}" --inside "$mode" \
      2>&1 | tee "${out}/${mode}.log"
    echo "##[endgroup]"
  done
  echo "##[group]Verdict"
  default_after="$(grep -E '^VERDICT default after-mousemove ' "${out}/default.log" | head -n 1)"
  noreset_after="$(grep -E '^VERDICT noreset after-mousemove ' "${out}/noreset.log" | head -n 1)"
  echo "${default_after}"
  echo "${noreset_after}"
  grep -h '^VERDICT' "${out}/default.log" "${out}/noreset.log" | tee "${out}/verdict.txt"
  echo "##[endgroup]"
  exit 0
fi

mode="$2"

stamp() { date -u +%H:%M:%S.%3N; }
log() { echo "[$(stamp)] $mode: $*"; }
pointer() { xdotool getmouselocation --shell 2>&1 | tr '\n' ' '; }
xy() { xdotool getmouselocation --shell 2>&1 | grep -E '^(X|Y)=' | tr '\n' ' ' | sed 's/ $//'; }

log "Xvfb argv: $(ps -o args= -C Xvfb)"
log "DISPLAY=${DISPLAY:-unset}; geometry: $(xdotool getdisplaygeometry 2>&1)"
log "xdotool: $(dpkg-query -W -f='${Package} ${Version}' xdotool 2>&1)"
log "python-xlib: $(python3 -c 'import Xlib; print(Xlib.__version__)' 2>&1)"
log "extensions:"
xdpyinfo -queryExtensions 2>&1 | grep -E 'number of extensions|XTEST|XInputExtension|XKEYBOARD' | sed 's/^/    /'
log "xwininfo -root -tree (no client yet):"
xwininfo -root -tree 2>&1 | sed 's/^/    /'

centre() {
  xdotool mousemove --sync 960 540 > /dev/null 2>&1
  sleep 0.3
}

# --- 1. what the script did: a one-shot xdotool move, then reads from new processes ------------
centre
log "1. start (a new xdotool process): $(xy)"
timeout 5 xdotool mousemove --sync 1919 1079
log "1. xdotool mousemove --sync 1919 1079 exited with $?"
first="$(xy)"
for i in 1 2 3; do
  log "1. read ${i} after mousemove (new process each): $(xy)"
  sleep 0.2
done
echo "VERDICT ${mode} after-mousemove ${first}"

# --- 2. D-42 step 1 as written: one-shot python-xlib XWarpPointer, read back in-process ---------
centre
log "2. start: $(xy)"
python3 - << 'PY'
from Xlib import display

d = display.Display()
root = d.screen().root
geometry = root.get_geometry()
root.warp_pointer(geometry.width - 1, geometry.height - 1)
d.sync()
pointer = root.query_pointer()
print(f"    in-process XQueryPointer after XWarpPointer + XSync: {pointer.root_x},{pointer.root_y}")
PY
second="$(xy)"
for i in 1 2 3; do
  log "2. read ${i} after the python process exited: $(xy)"
  sleep 0.2
done
echo "VERDICT ${mode} after-python-warp ${second}"

# --- 3. a client that stays connected keeps the server, and so the pointer, alive ---------------
centre
python3 -c 'import time; from Xlib import display; d = display.Display(); time.sleep(5)' &
keeper=$!
sleep 1
timeout 5 xdotool mousemove --sync 1919 1079
while_up="$(xy)"
for i in 1 2 3; do
  log "3. read ${i} while a client stays connected: $(xy)"
  sleep 0.2
done
echo "VERDICT ${mode} while-client-connected ${while_up}"
wait "$keeper"
sleep 0.3
after_last="$(xy)"
log "3. read after the last client left: ${after_last}"
echo "VERDICT ${mode} after-last-client-left ${after_last}"

# --- 4. a longer idle stretch with many short-lived clients (what the 200 ms watcher does) ------
centre
timeout 5 xdotool mousemove --sync 1919 1079
sleep 2
for _ in $(seq 1 10); do
  xdotool getmouselocation --shell > /dev/null 2>&1
  sleep 0.2
done
long="$(xy)"
log "4. 2 s idle + 10 short-lived reads later: ${long}"
echo "VERDICT ${mode} after-idle-and-reads ${long}"
