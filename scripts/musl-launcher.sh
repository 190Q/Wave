#!/bin/sh
set -eu

dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)"
binary="$dir/wave-bin"
helper_dir="${WAVE_WEBKIT_HELPER_DIR:-}"
bundle_dir="${WAVE_WEBKIT_BUNDLE_DIR:-}"
export GTK_USE_PORTAL="${GTK_USE_PORTAL-1}"

if [ -z "$helper_dir" ] && [ -z "$bundle_dir" ]; then
  exec "$binary" "$@"
fi

die() { printf 'wave: %s\n' "$*" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || die "WebKit path overrides require python3"
[ -f "$dir/wave-webkit.py" ] || die "wave-webkit.py is missing; reinstall Wave"

library="${WAVE_WEBKIT_LIBRARY:-}"
if [ -z "$library" ]; then
  library="$(ldd "$binary" | awk '$1 ~ /^libwebkit2gtk-4[.]1[.]so/ && $2 == "=>" { print $3; exit }')"
fi
[ -f "$library" ] || die "could not find libwebkit2gtk-4.1; set WAVE_WEBKIT_LIBRARY"

temp="$(mktemp -d /tmp/wv.XXXXXX)" || die "could not create a private WebKit directory"
trap 'rm -rf "$temp"' EXIT
python3 "$dir/wave-webkit.py" "$library" "$temp" || exit 1
# WebKit mounts library search paths inside its sandbox.
search_path="$temp"
for override in "$helper_dir" "$bundle_dir"; do
  [ -n "$override" ] || continue
  resolved="$(readlink -f "$override")" || die "could not resolve WebKit directory $override"
  case "$resolved" in *:*) die "WebKit override directories cannot contain ':'" ;; esac
  search_path="$search_path:$resolved"
done
export LD_LIBRARY_PATH="$search_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

"$binary" "$@" &
pid=$!
trap 'kill -INT "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; exit 130' INT
trap 'kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; exit 143' TERM
wait "$pid"
