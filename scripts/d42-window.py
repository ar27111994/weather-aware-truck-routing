"""TEMPORARY (D-42 smoke). Probe branch only. A stand-in for a browser window under Xvfb.

usage: d42-window.py X Y WIDTH HEIGHT SECONDS
Maps one top-level window (with a name and a class, as xdotool search wants) and keeps it for
SECONDS.
"""

import sys
import time

from Xlib import X, display

x, y, width, height, seconds = (int(value) for value in sys.argv[1:6])
screen_display = display.Display()
screen = screen_display.screen()
window = screen.root.create_window(
    x,
    y,
    width,
    height,
    0,
    screen.root_depth,
    X.InputOutput,
    X.CopyFromParent,
    background_pixel=screen.white_pixel,
    event_mask=X.ExposureMask,
)
window.set_wm_name("d42 smoke window")
window.set_wm_class("d42smoke", "D42Smoke")
window.map()
screen_display.sync()
time.sleep(seconds)
