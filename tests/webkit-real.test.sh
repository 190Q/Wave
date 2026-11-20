#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
helpers="${WAVE_TEST_WEBKIT_HELPERS:-/usr/libexec/webkit2gtk-4.1}"
bundle="${WAVE_TEST_WEBKIT_BUNDLE:-/usr/lib/webkit2gtk-4.1/injected-bundle}"
browser="${WAVE_TEST_WEBKIT_BROWSER:-$helpers/MiniBrowser}"
[ -x "$browser" ] || { printf 'WebKit MiniBrowser not found: %s\n' "$browser" >&2; exit 1; }
work="$(mktemp -d)"
pid=""
cleanup() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/helpers with spaces" "$work/injected bundle"
cp "$root/scripts/musl-launcher.sh" "$work/wave"
cp "$root/scripts/wave-webkit.py" "$work/wave-webkit.py"
ln -s "$browser" "$work/wave-bin"
for name in WebKitWebProcess WebKitNetworkProcess WebKitGPUProcess; do
  [ ! -f "$helpers/$name" ] || cp "$helpers/$name" "$work/helpers with spaces/$name"
done
cp "$bundle/libwebkit2gtkinjectedbundle.so" "$work/injected bundle/"
chmod +x "$work/wave"

export WAVE_WEBKIT_HELPER_DIR="$work/helpers with spaces"
export WAVE_WEBKIT_BUNDLE_DIR="$work/injected bundle"
"$work/wave" about:blank > "$work/output" 2>&1 &
pid=$!
if ! python3 "$root/scripts/check-webkit-paths.py" "$work" "$pid"; then
  cat "$work/output" >&2
  exit 1
fi
printf 'WebKit helpers and injected bundle loaded from their overridden directories\n'
