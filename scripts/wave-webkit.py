#!/usr/bin/env python3
import os
import re
import shutil
import sys
from pathlib import Path


def fail(message):
    raise ValueError(message)


def directory(name, required):
    value = os.environ.get(name)
    if not value:
        return None
    path = Path(value).resolve(strict=True)
    if not path.is_dir():
        fail(f"{name} must be a directory")
    for filename in required:
        if not (path / filename).is_file():
            fail(f"{name} is missing {filename}")
        if filename.startswith("WebKit") and not os.access(path / filename, os.X_OK):
            fail(f"{path / filename} is not executable")
    return path


def replace_path(data, original, replacement):
    old = os.fsencode(original) + b"\0"
    new = os.fsencode(replacement)
    if len(new) >= len(old):
        fail(f"temporary path {replacement} is too long for {original}")
    count = data.count(old)
    if not count:
        fail(f"WebKit does not contain the expected path {original}")
    return data.replace(old, new + b"\0" * (len(old) - len(new)))


def choose_path(data, override, suffix):
    if override:
        return override
    matches = set(re.findall(
        rb"(?<![\x20-\x7e])(/[^\x00\s]*?/webkit2gtk-4\.1" + suffix + rb")\x00",
        data,
    ))
    if len(matches) != 1:
        fail("could not identify WebKit's compiled-in path; set the corresponding WAVE_WEBKIT_*_TARGET")
    return os.fsdecode(matches.pop())


def main():
    library = Path(sys.argv[1]).resolve(strict=True)
    temporary = Path(sys.argv[2]).resolve(strict=True)
    helpers = directory("WAVE_WEBKIT_HELPER_DIR", ("WebKitNetworkProcess", "WebKitWebProcess"))
    bundle = directory("WAVE_WEBKIT_BUNDLE_DIR", ("libwebkit2gtkinjectedbundle.so",))
    data = library.read_bytes()

    if helpers:
        target = choose_path(data, os.environ.get("WAVE_WEBKIT_HELPER_TARGET"), rb"")
        link = temporary / "h"
        link.symlink_to(helpers, target_is_directory=True)
        data = replace_path(data, target, link)

    if bundle:
        target = choose_path(data, os.environ.get("WAVE_WEBKIT_BUNDLE_TARGET"), rb"/injected-bundle/?")
        link = temporary / "b"
        link.symlink_to(bundle, target_is_directory=True)
        replacement = str(link) + ("/" if target.endswith("/") else "")
        data = replace_path(data, target, replacement)

    output = temporary / "libwebkit2gtk-4.1.so.0"
    output.write_bytes(data)
    shutil.copymode(library, output)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, IndexError) as error:
        print(f"wave: could not configure WebKit: {error}", file=sys.stderr)
        sys.exit(1)
