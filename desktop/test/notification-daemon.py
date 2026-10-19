#!/usr/bin/env python3
"""Notification server for a private test bus; never registers on the user's bus."""

import json
import os
from pathlib import Path
import sys

from gi.repository import Gio, GLib

if os.environ.get("HUB_NOTIFICATION_PRIVATE_BUS") != "1":
    raise SystemExit("This fixture requires the private notification test bus.")

destination = Path(sys.argv[1])
events = []
active = set()
sequence = 0
connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
interface = "org.freedesktop.Notifications"
object_path = "/org/freedesktop/Notifications"
xml = """<node>
<interface name="org.freedesktop.Notifications">
 <method name="GetCapabilities"><arg type="as" direction="out"/></method>
 <method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method>
 <method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/></method>
 <method name="CloseNotification"><arg type="u" direction="in"/></method>
 <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
 <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
</interface>
<interface name="org.hub.NotificationTest">
 <method name="Activate"><arg type="u" direction="in"/></method>
</interface>
</node>"""


def record(event):
    events.append(event)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(events, ensure_ascii=False), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(destination)


def close(notification_id, reason):
    if notification_id not in active:
        return False
    active.remove(notification_id)
    record({"event": "closed", "id": notification_id, "reason": reason})
    connection.emit_signal(None, object_path, interface, "NotificationClosed", GLib.Variant("(uu)", (notification_id, reason)))
    return False


def method(_connection, _sender, _path, _interface, name, parameters, invocation):
    global sequence
    values = parameters.unpack()
    if name == "GetCapabilities":
        invocation.return_value(GLib.Variant("(as)", (["actions", "body", "body-markup", "persistence", "icon-static"],)))
    elif name == "GetServerInformation":
        invocation.return_value(GLib.Variant("(ssss)", ("Hub test server", "Hub", "1", "1.2")))
    elif name == "Notify":
        app, replaces, _icon, title, body, actions, hints, timeout = values
        sequence += 1
        notification_id = replaces or sequence
        active.add(notification_id)
        record({"event": "notify", "id": notification_id, "app": app, "title": title, "body": body,
                "actions": actions, "desktopEntry": hints.get("desktop-entry"), "timeout": timeout})
        invocation.return_value(GLib.Variant("(u)", (notification_id,)))
    elif name == "CloseNotification":
        close(values[0], 3)
        invocation.return_value(None)
    elif name == "Activate":
        notification_id = values[0]
        if notification_id in active:
            record({"event": "activated", "id": notification_id})
            connection.emit_signal(None, object_path, interface, "ActionInvoked", GLib.Variant("(us)", (notification_id, "default")))
            GLib.timeout_add(100, close, notification_id, 2)
        invocation.return_value(None)


for info in Gio.DBusNodeInfo.new_for_xml(xml).interfaces:
    connection.register_object(object_path, info, method, None, None)
Gio.bus_own_name_on_connection(connection, interface, Gio.BusNameOwnerFlags.NONE, None, None)
record({"event": "ready"})
GLib.MainLoop().run()
