#!/usr/bin/env python3
import array
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request


DEST = "org.mpris.MediaPlayer2.wave"
PATH = "/org/mpris/MediaPlayer2"
PLAYER = "org.mpris.MediaPlayer2.Player"


def call(method, *args, dest=DEST, path=PATH):
    return subprocess.check_output(
        ["gdbus", "call", "--session", "--dest", dest, "--object-path", path,
         "--method", method, "--", *map(str, args)],
        text=True,
        timeout=20,
    ).strip()


def property_value(name):
    return call("org.freedesktop.DBus.Properties.Get", PLAYER, name)


def position():
    value = property_value("Position")
    match = re.search(r"int64 (\d+)", value)
    if not match:
        raise AssertionError(f"Unexpected MPRIS position: {value}")
    return int(match.group(1))


def until(description, read, accepts):
    deadline = time.monotonic() + 30
    value = None
    while time.monotonic() < deadline:
        value = read()
        if accepts(value):
            return value
        time.sleep(0.25)
    raise AssertionError(f"{description}: unexpected value {value}")


def status(expected):
    until(expected, lambda: property_value("PlaybackStatus"), lambda value: f"'{expected}'" in value)


def title(expected):
    until(f"track {expected}", lambda: property_value("Metadata"),
          lambda value: f"'{expected}'" in value)


def reenable_controls(expected):
    api = os.environ.get("WAVE_TEST_MPRIS_API")
    if not api:
        return
    names = lambda: call("org.freedesktop.DBus.ListNames", dest="org.freedesktop.DBus",
                         path="/org/freedesktop/DBus")
    for enabled in (False, True):
        request = urllib.request.Request(
            f"{api}/api/settings", data=json.dumps({"systemMediaControls": enabled}).encode(),
            headers={"Content-Type": "application/json"}, method="PATCH",
        )
        with urllib.request.urlopen(request, timeout=20):
            pass
        if not enabled:
            assert DEST not in names()
    until("restarted media controls", names, lambda value: DEST in value)
    status(expected)
    if len(sys.argv) > 2:
        title(sys.argv[2])


def at(expected):
    until(f"position near {expected}", position, lambda value: abs(value - expected) <= 500_000)


def playing_at(expected):
    until(f"playing position near {expected}", position,
          lambda value: expected - 500_000 <= value <= expected + 3_000_000)


def webkit_players():
    names = call("org.freedesktop.DBus.ListNames", dest="org.freedesktop.DBus",
                 path="/org/freedesktop/DBus")
    assert DEST in names, names
    return re.findall(r"'(org\.mpris\.MediaPlayer2\.(?:org\.webkit|webkit|com\.wave\.app\.Sandboxed)[^']*)'", names)


def webkit_call(method, *args):
    names = until("WebKit media player", webkit_players, bool)
    return call(f"{PLAYER}.{method}", *args, dest=names[0])


def audible(monitor):
    with tempfile.TemporaryFile() as output:
        capture = subprocess.Popen(
            ["parec", f"--device={monitor}", "--format=s16le", "--rate=8000", "--channels=1"],
            stdout=output,
        )
        time.sleep(3)
        if capture.poll() is not None:
            raise AssertionError("Could not capture the test audio sink")
        capture.terminate()
        capture.wait(timeout=10)
        output.seek(0)
        samples = array.array("h")
        samples.frombytes(output.read())
        assert samples, "The test audio sink produced no samples"
        return max(abs(sample) for sample in samples) >= 256


status("Playing")
reenable_controls("Playing")
call(f"{PLAYER}.Pause")
status("Paused")
reenable_controls("Paused")
call(f"{PLAYER}.SetPosition", "/", 70_000_000)
at(70_000_000)
call(f"{PLAYER}.Seek", -10_000_000)
at(60_000_000)
call(f"{PLAYER}.Seek", 10_000_000)
at(70_000_000)
call(f"{PLAYER}.Seek", 10_000_000)
at(80_000_000)
call(f"{PLAYER}.Seek", 10_000_000)
call(f"{PLAYER}.Seek", 10_000_000)
call(f"{PLAYER}.Seek", 10_000_000)
at(110_000_000)
call(f"{PLAYER}.SetPosition", "/", 5_000_000)
at(5_000_000)
call(f"{PLAYER}.Seek", -10_000_000)
at(0)
call(f"{PLAYER}.PlayPause")
status("Playing")
until("playback advancing", position, lambda value: value >= 1_000_000)
call(f"{PLAYER}.SetPosition", "/", 70_000_000)
playing_at(70_000_000)
call(f"{PLAYER}.Seek", -10_000_000)
playing_at(60_000_000)
call(f"{PLAYER}.Seek", 10_000_000)
playing_at(70_000_000)
status("Playing")
call(f"{PLAYER}.PlayPause")
status("Paused")
paused = position()
time.sleep(2)
assert abs(position() - paused) <= 500_000, "Playback continued after pausing"
if len(sys.argv) > 1:
    assert not audible(sys.argv[1]), "Audio continued after pausing"
call(f"{PLAYER}.Play")
status("Playing")
if len(sys.argv) > 1:
    assert audible(sys.argv[1]), "Audio did not resume after playing"
call(f"{PLAYER}.Pause")
status("Paused")

call(f"{PLAYER}.Play")
status("Playing")
time.sleep(2)
webkit_names = webkit_players()
if os.environ.get("WAVE_TEST_EXPECT_WEBKIT") == "1":
    assert webkit_names, "WebKit did not register the expected MPRIS player"
if webkit_names:
    if len(sys.argv) > 2:
        until("WebKit track metadata",
              lambda: call("org.freedesktop.DBus.Properties.Get", PLAYER, "Metadata",
                           dest=webkit_players()[0]),
              lambda value: sys.argv[2] in value)
    webkit_call("Pause")
    status("Paused")
    if len(sys.argv) > 1:
        time.sleep(2)
        assert not audible(sys.argv[1]), "Audio continued after WebKit paused"
    call(f"{PLAYER}.SetPosition", "/", 70_000_000)
    at(70_000_000)
    webkit_call("Seek", -10_000_000)
    at(60_000_000)
    webkit_call("Seek", 10_000_000)
    at(70_000_000)
    webkit_call("Seek", 10_000_000)
    webkit_call("Seek", 10_000_000)
    webkit_call("Seek", 10_000_000)
    at(100_000_000)
    webkit_call("PlayPause")
    status("Playing")
    if len(sys.argv) > 1:
        assert audible(sys.argv[1]), "Audio did not resume through WebKit"
    webkit_call("PlayPause")
    status("Paused")
    call(f"{PLAYER}.SetPosition", "/", 5_000_000)
    at(5_000_000)
    webkit_call("Seek", -10_000_000)
    at(0)
    webkit_call("Play")
    status("Playing")
    call(f"{PLAYER}.SetPosition", "/", 70_000_000)
    playing_at(70_000_000)
    webkit_call("Seek", -10_000_000)
    playing_at(60_000_000)
    webkit_call("Seek", 10_000_000)
    playing_at(70_000_000)
    webkit_call("PlayPause")
    webkit_call("PlayPause")
    time.sleep(2)
    status("Playing")
    webkit_call("Pause")
    status("Paused")
    print("WebKit MPRIS playback and relative seeking passed")
else:
    call(f"{PLAYER}.Pause")
    status("Paused")
    print("WebKit did not expose a separate MPRIS player")
print("Wave MPRIS playback and relative seeking passed")
