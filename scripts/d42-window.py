"""TEMPORARY (D-42 smoke). Probe branch only. A stand-in for a browser window under Xvfb.

usage: d42-window.py X Y WIDTH HEIGHT SECONDS [HIDDEN_FIRST_SECONDS]
Maps one top-level window (with a name and a class, as xdotool search wants) and keeps it for
SECONDS. With HIDDEN_FIRST_SECONDS, an unmapped 1x1 helper window exists first (as Firefox creates
its hidden helper windows) and the real window is mapped only after that many seconds.
"""

import sys
import time

from Xlib import X, display

x, y, width, height, seconds = (int(value) for value in sys.argv[1:6])
hidden_first = int(sys.argv[6]) if len(sys.argv) > 6 else 0
screen_display = display.Display()
screen = screen_display.screen()


def create(name, left, top, w, h):
    window = screen.root.create_window(
        left,
        top,
        w,
        h,
        0,
        screen.root_depth,
        X.InputOutput,
        X.CopyFromParent,
        background_pixel=screen.white_pixel,
        event_mask=X.ExposureMask,
    )
    window.set_wm_name(name)
    window.set_wm_class("d42smoke", "D42Smoke")
    return window


if hidden_first:
    create("d42 hidden helper", 0, 0, 1, 1)
    screen_display.sync()
    time.sleep(hidden_first)
main = create("d42 smoke window", x, y, width, height)
main.map()
screen_display.sync()
time.sleep(seconds)
