#!/usr/bin/env bash
# TEMPORARY (D-42 smoke). Lives only on the throwaway branch ci/d41-probe; never merged.
# Runs the REAL scripts/e2e-xvfb.sh against stand-in commands (python-xlib windows instead of a
# browser) and checks what it logs, what it exits with, and that each fail-closed rule bites.
set -uo pipefail

out="${1:?usage: d42-smoke.sh <output-dir>}"
mkdir -p "$out"
export CI=true E2E_FIREFOX_XVFB=1

fails=0
rc=0

run() { # run <label> <command...>: the script's log goes to <out>/<label>.log, its status to $rc
  local label="$1"
  shift
  bash scripts/e2e-xvfb.sh "$@" > "${out}/${label}.log" 2>&1
  rc=$?
  echo "exit=${rc}" >> "${out}/${label}.log"
  echo "##[group]${label}: exit ${rc}"
  cat "${out}/${label}.log"
  echo "##[endgroup]"
}

expect_rc() { # expect_rc <label> <status>
  if [ "$rc" = "$2" ]; then
    echo "PASS  $1: exit status is $2"
  else
    echo "FAIL  $1: exit status is ${rc}, expected $2"
    fails=$((fails + 1))
  fi
}

expect() { # expect <label> <description> <fixed string the log must contain>
  if grep -qF -- "$3" "${out}/$1.log"; then
    echo "PASS  $1: $2"
  else
    echo "FAIL  $1: $2 (the log lacks: $3)"
    fails=$((fails + 1))
  fi
}

# 1. nothing happens: exit 0, 0 violations, the D-42 logs are there.
run quiet bash -c 'sleep 5'
expect_rc quiet 0
expect quiet "the Xvfb argv shows -noreset" "-noreset"
expect quiet "the server's extensions are logged" "(opcode: "
expect quiet "the pointer starts at the centre" "the pointer starts at X=960 Y=540"
expect quiet "the pointer is parked at the far corner" "pointer parked at X=1919 Y=1079"
expect quiet "the start proof names the root window with 0 children" \
  "the window under it is the root window 543, which has 0 children"
expect quiet "0 violations" " 0 violations"

# 2. a small window away from the park point: logged once, 0 violations.
run window-away python3 scripts/d42-window.py 100 100 640 480 6
expect_rc window-away 0
expect window-away "the window tree is logged" "the window tree once a client window exists"
expect window-away "the window shows in the tree" "d42 smoke window"
expect window-away "the visible window's geometry is logged" "Position: 100,100"
expect window-away "0 violations" " 0 violations"

# 3. teeth: a command that moves the pointer.
run moved bash -c 'sleep 1; xdotool mousemove 10 10; sleep 1'
expect_rc moved 1
expect moved "a violation line is logged" "pointer off its park point or under a window"

# 4. teeth: a window over the park point.
run covered python3 scripts/d42-window.py 0 0 1920 1080 4
expect_rc covered 1
expect covered "a violation line is logged" "pointer off its park point or under a window"
expect covered "the covering window's geometry is logged" "Geometry: 1920x1080"

# 5. teeth: no opt-in.
env -u E2E_FIREFOX_XVFB bash scripts/e2e-xvfb.sh true > "${out}/no-opt-in.log" 2>&1
rc=$?
echo "exit=${rc}" >> "${out}/no-opt-in.log"
cat "${out}/no-opt-in.log"
expect_rc no-opt-in 1
expect no-opt-in "the message names D-41" "D-41"

# 6. the command's own status comes through when nothing is wrong.
run status bash -c 'sleep 1; exit 3'
expect_rc status 3
expect status "0 violations" " 0 violations"

# 7. teeth: a server that resets would undo the park, and the start check must still fail closed.
sed '/^readonly XVFB_SERVER_ARGS=/ s/ -noreset//' scripts/e2e-xvfb.sh > "${out}/e2e-xvfb-reset.sh"
if grep -q '^readonly XVFB_SERVER_ARGS=.*-noreset' "${out}/e2e-xvfb-reset.sh"; then
  echo "FAIL  reset: the copy still has -noreset on the server line"
  fails=$((fails + 1))
fi
bash "${out}/e2e-xvfb-reset.sh" true > "${out}/reset.log" 2>&1
rc=$?
echo "exit=${rc}" >> "${out}/reset.log"
echo "##[group]reset: exit ${rc}"
cat "${out}/reset.log"
echo "##[endgroup]"
expect_rc reset 1
expect reset "the park check fails and says why" "the server must run with -noreset"

# 8 and 9. the start proof (D-41): a window that exists before the park is refused. The test starts
# its own Xvfb, puts a stand-in window up, and calls the script's own --inside-xvfb entry, so the
# script needs no test knob.
before_park() { # before_park <label> <window args...>
  local label="$1"
  shift
  xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24 -noreset" bash -c '
    python3 scripts/d42-window.py "$@" &
    window=$!
    sleep 2
    bash scripts/e2e-xvfb.sh --inside-xvfb true
    status=$?
    kill "$window" 2> /dev/null
    exit "$status"
  ' _ "$@" > "${out}/${label}.log" 2>&1
  rc=$?
  echo "exit=${rc}" >> "${out}/${label}.log"
  echo "##[group]${label}: exit ${rc}"
  cat "${out}/${label}.log"
  echo "##[endgroup]"
}
before_park covered-before-park 0 0 1920 1080 20
expect_rc covered-before-park 1
expect covered-before-park "the window under the park point is refused" "a window already covers it"
before_park window-before-park 100 100 640 480 20
expect_rc window-before-park 1
expect window-before-park "a client window before the park is refused" \
  "a client window exists before the park is proven"

echo "SMOKE fails=${fails}" | tee "${out}/verdict.txt"
exit "$fails"
