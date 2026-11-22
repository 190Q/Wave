#!/usr/bin/env python3
import json
import os
import subprocess
import time

import gi

print("Starting GTK WebKit popup test", flush=True)
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2


window = Gtk.Window()
window.set_title("Wave popup test")
window.set_default_size(360, 720)
window.set_decorated(False)
print("Creating WebKitGTK view", flush=True)
view = WebKit2.WebView()
window.add(view)
window.show_all()
load = {"finished": False}


def load_failed(_view, _event, uri, error):
    print(f"WebKit load failed for {uri}: {error}", flush=True)
    load["error"] = str(error)
    return False


def load_changed(_view, event):
    if event == WebKit2.LoadEvent.FINISHED and view.get_uri() == os.environ["WAVE_TEST_URL"]:
        load["finished"] = True
        print(f"WebKit finished loading {view.get_uri()}", flush=True)


def process_terminated(_view, reason):
    load["error"] = f"WebKit process terminated: {reason.value_nick}"
    print(load["error"], flush=True)


view.connect("load-failed", load_failed)
view.connect("load-changed", load_changed)
view.connect("web-process-terminated", process_terminated)
print(f"Loading {os.environ['WAVE_TEST_URL']} in WebKitGTK", flush=True)
view.load_uri(os.environ["WAVE_TEST_URL"])


def wait(milliseconds):
    loop = GLib.MainLoop()
    GLib.timeout_add(milliseconds, lambda: (loop.quit(), False)[1])
    loop.run()


def javascript(expression):
    loop = GLib.MainLoop()
    result = {}

    def finished(webview, task, _):
        try:
            value = webview.evaluate_javascript_finish(task)
            result["value"] = json.loads(value.to_json(0))
        except Exception as error:
            result["error"] = error
        loop.quit()

    view.evaluate_javascript(expression, -1, None, None, None, finished, None)
    def timed_out():
        result["timeout"] = True
        loop.quit()
        return False

    timeout = GLib.timeout_add_seconds(30, timed_out)
    loop.run()
    if not result.get("timeout"):
        GLib.source_remove(timeout)
    if "error" in result:
        raise result["error"]
    if "value" not in result:
        raise RuntimeError(load.get("error", "WebKit did not finish evaluating JavaScript"))
    return result["value"]


def until(expression, expected=True, seconds=60):
    deadline = time.monotonic() + seconds
    actual = None
    while time.monotonic() < deadline:
        actual = javascript(expression)
        if actual == expected:
            return
        wait(200)
    raise AssertionError(f"{expression}: expected {expected!r}, got {actual!r}")


def click(x, y):
    subprocess.run(["xdotool", "mousemove", str(x), str(y), "click", "1"], check=True)


def open_search():
    rect = javascript("""(() => {
      const rect = document.getElementById("search-open").getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()""")
    click(rect["x"], rect["y"])
    until("!document.getElementById('search-modal').hidden")
    wait(300)


def closed():
    until("document.getElementById('search-modal').hidden")
    assert javascript("document.getElementById('search').value") == ""


try:
    deadline = time.monotonic() + 120
    while not load["finished"] and "error" not in load and time.monotonic() < deadline:
        wait(200)
    if "error" in load:
        raise RuntimeError(load["error"])
    if not load["finished"]:
        raise RuntimeError("WebKit did not finish loading the phone simulator")
    until("""Boolean(document.querySelector("#search-open") &&
      !document.documentElement.classList.contains("is-starting"))""")
    assert javascript("document.documentElement.dataset.device") == "linuxPhone"
    print("Linux phone simulator is ready", flush=True)
    javascript("""(() => {
      window.popupEvents = [];
      for (const type of ["pointerdown", "mousedown", "touchstart", "click"]) {
        document.addEventListener(type, (event) => {
          window.popupEvents.push({ type, target: event.target.id });
        }, true);
      }
      return true;
    })()""")

    open_search()
    assert javascript("document.elementFromPoint(180, 620).id") == "search-modal"
    javascript("""(() => {
      const search = document.getElementById("search");
      search.value = "wave";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.dispatchEvent(new Event("touchstart", { bubbles: true }));
      return true;
    })()""")
    assert not javascript("document.getElementById('search-modal').classList.contains('is-closed')")
    javascript("window.popupEvents = []; true")
    click(180, 620)
    closed()
    events = javascript("window.popupEvents")
    assert any(event["type"] == "mousedown" and event["target"] == "search-modal" for event in events), events
    print(f"Native mouse backdrop click dismissed search: {events}", flush=True)

    open_search()
    javascript("document.getElementById('search-modal').click(); true")
    closed()
    print("Synthetic backdrop click dismissed search", flush=True)

    open_search()
    javascript("window.popupEvents = []; true")
    touch_type = javascript("""(() => {
      const target = document.elementFromPoint(180, 620);
      let event;
      try {
        const touch = new Touch({ identifier: 1, target, clientX: 180, clientY: 620 });
        event = new TouchEvent("touchstart", { bubbles: true, touches: [touch], changedTouches: [touch] });
      } catch {
        try {
          event = new TouchEvent("touchstart", { bubbles: true });
        } catch {
          event = new Event("touchstart", { bubbles: true });
        }
      }
      target.dispatchEvent(event);
      return event.constructor.name;
    })()""")
    closed()
    events = javascript("window.popupEvents")
    assert events == [{"type": "touchstart", "target": "search-modal"}], events
    print(f"Touch-only backdrop event dismissed search: {touch_type}", flush=True)

    javascript("""(() => {
      import("/src/ui/menu.ts").then(({ openMenu }) => {
        openMenu(document.getElementById("search-open"), [{ label: "Test", action() {} }]);
      });
      return true;
    })()""")
    until("Boolean(document.querySelector('.menu'))")
    wait(100)
    javascript("""(() => {
      const menu = document.querySelector(".menu");
      menu.dispatchEvent(new Event("touchstart", { bubbles: true }));
      const cancelled = new MouseEvent("click", { bubbles: true, cancelable: true });
      cancelled.preventDefault();
      document.getElementById("stage").dispatchEvent(cancelled);
      return true;
    })()""")
    assert javascript("Boolean(document.querySelector('.menu'))")
    javascript("""(() => {
      document.getElementById("stage").dispatchEvent(new TouchEvent("touchstart", { bubbles: true }));
      return true;
    })()""")
    until("!document.querySelector('.menu')")
    print("Touch outside a menu dismissed it without breaking inside or suppressed clicks", flush=True)
finally:
    window.destroy()
