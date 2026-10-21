#!/usr/bin/python3
"""X11-only native URI-list drag source for isolated desktop regression tests.
Usage: DISPLAY=:92 python3 native-drag.py TARGET_X TARGET_Y FILE [FILE ...]
Requires python3-gi, GTK3, python3-xlib, XTest. Never use on a user's display.
A successful exit means GTK delivered data and received drag-end; the caller
must separately assert that its target uploaded the expected bytes.
"""
import os
import sys
from pathlib import Path
os.environ['GDK_BACKEND'] = 'x11'
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib
from Xlib import X, display
from Xlib.ext import xtest

if len(sys.argv) < 4:
    raise SystemExit(__doc__)
if os.environ.get('DISPLAY', '').split('.')[0] in (':0', ':1'):
    raise SystemExit('Refusing the normal interactive display; use isolated Xvfb.')
target_x, target_y = map(int, sys.argv[1:3])
uris = [Path(name).resolve(strict=True).as_uri() for name in sys.argv[3:]]
xdisplay = display.Display()
window = Gtk.Window(title='Hub native drag fixture')
window.set_decorated(False)
window.set_default_size(160, 100)
window.move(0, 0)
label = Gtk.EventBox()
label.add(Gtk.Label(label='Native file source'))
window.add(label)
label.drag_source_set(Gdk.ModifierType.BUTTON1_MASK,
                      [Gtk.TargetEntry.new('text/uri-list', 0, 0)],
                      Gdk.DragAction.COPY)
state = {'provided': False, 'ended': False}
def provide(widget, context, selection, info, timestamp):
    selection.set_uris(uris)
    state['provided'] = True
    print('NATIVE_DRAG_DATA ' + str(len(uris)), flush=True)
def ended(widget, context):
    state['ended'] = True
    GLib.timeout_add(150, Gtk.main_quit)
label.connect('drag-data-get', provide)
label.connect('drag-end', ended)
window.show_all()
steps = [(X.MotionNotify, 80, 50), (X.ButtonPress, 1, None)]
steps += [(X.MotionNotify, round(80 + (target_x - 80) * i / 30),
           round(50 + (target_y - 50) * i / 30)) for i in range(1, 31)]
steps += [(None, None, None)] * 8 + [(X.ButtonRelease, 1, None)]
def tick():
    if not steps:
        return False
    kind, first, second = steps.pop(0)
    if kind == X.MotionNotify:
        xtest.fake_input(xdisplay, kind, x=first, y=second)
    elif kind:
        xtest.fake_input(xdisplay, kind, detail=first)
    xdisplay.sync()
    return True
def begin():
    GLib.timeout_add(45, tick)
    return False
GLib.timeout_add(300, begin)
GLib.timeout_add(10000, Gtk.main_quit)
try:
    Gtk.main()
finally:
    xtest.fake_input(xdisplay, X.ButtonRelease, detail=1)
    xdisplay.sync()
    window.destroy()
    xdisplay.close()
if not (state['provided'] and state['ended']):
    raise SystemExit('Native drop did not complete: ' + str(state))
print('NATIVE_DRAG_COMPLETE', flush=True)
