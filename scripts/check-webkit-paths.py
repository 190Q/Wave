#!/usr/bin/env python3
import os
import sys
import time
from pathlib import Path

work = Path(sys.argv[1])
launcher = int(sys.argv[2])
helpers = {
    name: str((work / "helpers with spaces" / name).resolve())
    for name in ("WebKitWebProcess", "WebKitNetworkProcess")
}
bundle = str((work / "injected bundle" / "libwebkit2gtkinjectedbundle.so").resolve())
found = {}
for _ in range(180):
    found = {}
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            args = (process / "cmdline").read_bytes().split(b"\0")
            paths = {os.path.realpath(os.fsdecode(arg)) for arg in args if arg.startswith(b"/")}
            for name, path in helpers.items():
                if path in paths:
                    found[name] = process
        except OSError:
            continue
    web = found.get("WebKitWebProcess")
    if web and "WebKitNetworkProcess" in found:
        try:
            if bundle in (web / "maps").read_text():
                sys.exit(0)
        except OSError:
            pass
    if not Path(f"/proc/{launcher}").exists():
        break
    time.sleep(1)
print(f"WebKit did not load the overridden helpers and injected bundle: {found}", file=sys.stderr)
sys.exit(1)
