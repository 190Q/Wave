#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/home" "$work/archive"
export HOME="$work/home"
export PATH="$work/bin:/usr/bin:/bin"
export MOCK_LOG="$work/log"
export MOCK_ARCHIVE="$work/phone.tar.gz"
export MOCK_JSON="$work/release.json"
export MOCK_ARCH=aarch64 MOCK_LIBC=musl
unset WAVE_PREFIX
: > "$MOCK_LOG"

cat > "$work/bin/uname" <<'MOCK'
#!/bin/sh
printf '%s\n' "${MOCK_ARCH:-aarch64}"
MOCK
cat > "$work/bin/ldd" <<'MOCK'
#!/bin/sh
printf '%s\n' "${MOCK_LIBC:-musl}"
MOCK
cat > "$work/bin/id" <<'MOCK'
#!/bin/sh
printf '%s\n' "${MOCK_UID:-1000}"
MOCK
cat > "$work/bin/apk" <<'MOCK'
#!/bin/sh
if [ "$1" = info ]; then
  [ "${MOCK_DEPS_INSTALLED:-0}" = 1 ]
else
  printf 'apk %s\n' "$*" >> "$MOCK_LOG"
  [ "${MOCK_APK_FAIL:-0}" != 1 ]
fi
MOCK
cat > "$work/bin/sudo" <<'MOCK'
#!/bin/sh
exec "$@"
MOCK
cat > "$work/bin/dpkg" <<'MOCK'
#!/bin/sh
exit 1
MOCK
cat > "$work/bin/apt-get" <<'MOCK'
#!/bin/sh
printf 'apt-get %s\n' "$*" >> "$MOCK_LOG"
MOCK
cat > "$work/bin/curl" <<'MOCK'
#!/bin/sh
case "$*" in
  *api.github.com*) cat "$MOCK_JSON"; exit ;;
esac
[ "${MOCK_CURL_FAIL:-0}" != 1 ] || exit 1
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then
    cp "$MOCK_ARCHIVE" "$2"
    exit
  fi
  shift
done
exit 1
MOCK
chmod +x "$work/bin/"*

cp "$root/scripts/musl-launcher.sh" "$work/archive/wave"
cp "$root/scripts/wave-webkit.py" "$work/archive/wave-webkit.py"
cp "$root/install.sh" "$work/archive/install.sh"
printf '1.2.3\n' > "$work/archive/VERSION"
cat > "$work/archive/wave-bin" <<'MOCK'
#!/bin/sh
printf '%s\n' "$@" > "$HOME/launched"
printf '%s\n' "${GTK_USE_PORTAL-unset}" > "$HOME/portal"
MOCK
chmod +x "$work/archive/wave" "$work/archive/wave-bin"
tar -czf "$MOCK_ARCHIVE" -C "$work/archive" wave wave-bin wave-webkit.py install.sh VERSION
cat > "$MOCK_JSON" <<'JSON'
{"browser_download_url": "https://example.test/Wave_1.2.3_aarch64_musl.tar.gz"}
{"browser_download_url": "https://example.test/Wave_1.2.3_aarch64.AppImage"}
{"browser_download_url": "https://example.test/Wave_1.2.3_arm64.deb"}
JSON

MOCK_DEPS_INSTALLED=1 sh "$root/install.sh" --version 1.2.3 > "$work/default.log" 2> "$work/default.err"
[ -x "$HOME/.local/bin/wave" ] && [ -x "$HOME/.local/bin/wave-bin" ] && [ -f "$HOME/.local/bin/wave-webkit.py" ]
grep -Fxq "Wave 1.2.3 installed to $HOME/.local/bin/wave" "$work/default.log"
grep -Fq "Exec=\"$HOME/.local/bin/wave\"" "$HOME/.local/share/applications/wave.desktop"
! grep -Fq "warning: Running as root:" "$work/default.err"
MOCK_DEPS_INSTALLED=1 sh "$work/archive/install.sh" --local > "$work/default.log" 2> "$work/default.err"
grep -Fxq "Wave 1.2.3 installed to $HOME/.local/bin/wave" "$work/default.log"
MOCK_UID=0 MOCK_DEPS_INSTALLED=1 sh "$work/archive/install.sh" --local > "$work/root.log" 2> "$work/root.err"
grep -Fq "warning: Running as root: the desktop entry and default install use $HOME." "$work/root.err"
sh "$root/install.sh" --uninstall
[ ! -e "$HOME/.local/bin/wave" ] && [ ! -e "$HOME/.local/bin/wave-bin" ] && [ ! -e "$HOME/.local/bin/wave-webkit.py" ]
[ ! -e "$HOME/.local/share/applications/wave.desktop" ]
printf 'default installation uses the current home and warns when run as root\n'

env_prefix="$work/environment prefix"
WAVE_PREFIX="$env_prefix" MOCK_DEPS_INSTALLED=1 sh "$work/archive/install.sh" --local
[ -x "$env_prefix/bin/wave" ] && [ -x "$env_prefix/bin/wave-bin" ]
grep -Fq "Exec=\"$env_prefix/bin/wave\"" "$HOME/.local/share/applications/wave.desktop"
WAVE_PREFIX="$env_prefix" sh "$root/install.sh" --uninstall
[ ! -e "$env_prefix/bin/wave" ] && [ ! -e "$HOME/.local/share/applications/wave.desktop" ]
printf 'WAVE_PREFIX changes the install location\n'

prefix="$work/custom prefix"
sh "$root/install.sh" --version 1.2.3 --dir "$prefix"
grep -q 'apk add .*webkit2gtk-4.1' "$MOCK_LOG"
grep -q 'gst-plugins-good' "$MOCK_LOG"
grep -q 'yt-dlp ffmpeg deno' "$MOCK_LOG"
grep -q 'yt-dlp-ejs-rt-deno' "$MOCK_LOG"
grep -q 'glib-networking' "$MOCK_LOG"
grep -q 'mesa-dri-gallium' "$MOCK_LOG"
grep -q 'mesa-gles' "$MOCK_LOG"
grep -q 'xdg-desktop-portal-phosh' "$MOCK_LOG"
[ -x "$prefix/bin/wave" ] && [ -x "$prefix/bin/wave-bin" ] && [ -f "$prefix/bin/wave-webkit.py" ]
grep -Fq "Exec=\"$prefix/bin/wave\"" "$HOME/.local/share/applications/wave.desktop"
"$prefix/bin/wave" help
grep -qx help "$HOME/launched"
grep -qx 1 "$HOME/portal"
GTK_USE_PORTAL=0 "$prefix/bin/wave" help
grep -qx 0 "$HOME/portal"
sh "$root/install.sh" --dir "$prefix" --uninstall
[ ! -e "$prefix/bin/wave" ] && [ ! -e "$prefix/bin/wave-bin" ] && [ ! -e "$prefix/bin/wave-webkit.py" ]
[ ! -e "$HOME/.local/share/applications/wave.desktop" ]
printf 'musl installation, launch, and uninstall passed\n'

: > "$MOCK_LOG"
MOCK_CURL_FAIL=1 sh "$work/archive/install.sh" --local --dir "$prefix"
[ -x "$prefix/bin/wave-bin" ] && [ -f "$prefix/bin/wave-webkit.py" ]
printf 'extracted phone archives install without downloading another archive\n'

mkdir "$work/legacy-archive"
cp "$work/archive/wave-bin" "$work/legacy-archive/wave"
WAVE_LOCAL_PACKAGE_DIR="$work/legacy-archive" MOCK_DEPS_INSTALLED=1 \
  sh "$root/install.sh" --local --dir "$prefix"
[ ! -e "$prefix/bin/wave-bin" ] && [ ! -e "$prefix/bin/wave-webkit.py" ]
"$prefix/bin/wave" old-local-release
grep -qx old-local-release "$HOME/launched"
printf 'legacy extracted phone archives install with the current installer\n'

: > "$MOCK_LOG"
MOCK_DEPS_INSTALLED=1 sh "$root/install.sh" --version 1.2.3 --dir "$prefix"
[ ! -s "$MOCK_LOG" ]
printf 'installed dependencies are not reinstalled\n'

printf 'existing install\n' > "$prefix/bin/wave"
if MOCK_APK_FAIL=1 sh "$root/install.sh" --version 1.2.3 --dir "$prefix"; then
  printf 'dependency installation unexpectedly succeeded\n' >&2
  exit 1
fi
grep -qx 'existing install' "$prefix/bin/wave"
if MOCK_CURL_FAIL=1 sh "$root/install.sh" --version 1.2.3 --dir "$prefix"; then
  printf 'failed download unexpectedly succeeded\n' >&2
  exit 1
fi
grep -qx 'existing install' "$prefix/bin/wave"
printf 'failed installs preserve the existing executable\n'

tar -czf "$MOCK_ARCHIVE" -C "$work/archive" wave
if MOCK_DEPS_INSTALLED=1 sh "$root/install.sh" --version 1.2.3 --dir "$prefix"; then
  printf 'incomplete phone package unexpectedly succeeded\n' >&2
  exit 1
fi
grep -qx 'existing install' "$prefix/bin/wave"
tar -czf "$MOCK_ARCHIVE" -C "$work/archive" wave wave-bin wave-webkit.py install.sh VERSION
printf 'incomplete phone packages preserve the existing executable\n'

printf '%s\n' '{"browser_download_url": "https://example.test/Wave_1.2.3_aarch64.AppImage"}' > "$MOCK_JSON"
if sh "$root/install.sh" --version 1.2.3 --dir "$prefix"; then
  printf 'missing musl asset unexpectedly succeeded\n' >&2
  exit 1
fi
if MOCK_ARCH=x86_64 sh "$root/install.sh" --version 1.2.3 --dir "$prefix"; then
  printf 'unsupported musl architecture unexpectedly succeeded\n' >&2
  exit 1
fi
mv "$work/bin/apk" "$work/bin/apk-disabled"
if ! command -v apk >/dev/null 2>&1; then
  if sh "$root/install.sh" --version 1.2.3 --dir "$prefix"; then
    printf 'musl installation without apk unexpectedly succeeded\n' >&2
    exit 1
  fi
fi
mv "$work/bin/apk-disabled" "$work/bin/apk"
grep -qx 'existing install' "$prefix/bin/wave"
printf 'missing assets and unsupported architectures are rejected\n'

printf '%s\n' '{"browser_download_url": "https://example.test/Wave_1.2.3_arm64.deb"}' > "$MOCK_JSON"
MOCK_LIBC=glibc sh "$root/install.sh" --version 1.2.3 --dir "$prefix"
grep -q 'apt-get install -y' "$MOCK_LOG"
printf 'glibc systems still select the native package\n'

printf '%s\n' '{"browser_download_url": "https://example.test/Wave_1.2.3_aarch64.AppImage"}' > "$MOCK_JSON"
appimage_prefix="$work/appimage"
MOCK_LIBC=glibc MOCK_UID=0 sh "$root/install.sh" --version 1.2.3 --dir "$appimage_prefix" 2> "$work/root.err"
[ -x "$appimage_prefix/bin/wave" ]
[ ! -e "$appimage_prefix/bin/wave-bin" ]
grep -Fq "warning: Running as root: the desktop entry and default install use $HOME." "$work/root.err"
sh "$root/install.sh" --dir "$appimage_prefix" --uninstall
[ ! -e "$appimage_prefix/bin/wave" ]
printf 'glibc AppImage installation and uninstall still work\n'

printf '%s\n' '{"browser_download_url": "https://example.test/Wave_1.2.3_aarch64_musl.tar.gz"}' > "$MOCK_JSON"
cp "$work/archive/wave-bin" "$work/archive/wave"
tar -czf "$MOCK_ARCHIVE" -C "$work/archive" wave
MOCK_DEPS_INSTALLED=1 sh "$root/install.sh" --version 1.2.3 --dir "$prefix"
[ ! -e "$prefix/bin/wave-bin" ]
"$prefix/bin/wave" old-release
grep -qx old-release "$HOME/launched"
printf 'legacy single-binary tarballs still install\n'

if command -v python3 >/dev/null 2>&1; then
  mkdir -p "$work/launcher" "$work/helpers/custom" "$work/bundle"
  cp "$root/scripts/musl-launcher.sh" "$work/launcher/wave"
  cp "$root/scripts/wave-webkit.py" "$work/launcher/wave-webkit.py"
  cat > "$work/launcher/wave-bin" <<'MOCK'
#!/bin/sh
dir="${LD_LIBRARY_PATH%%:*}"
if [ -n "${WAVE_WEBKIT_HELPER_DIR:-}" ]; then
  [ "$(readlink -f "$dir/h")" = "$(readlink -f "$WAVE_WEBKIT_HELPER_DIR")" ]
  case ":$LD_LIBRARY_PATH:" in *":$(readlink -f "$WAVE_WEBKIT_HELPER_DIR"):"*) ;; *) exit 1 ;; esac
fi
if [ -n "${WAVE_WEBKIT_BUNDLE_DIR:-}" ]; then
  [ "$(readlink -f "$dir/b")" = "$(readlink -f "$WAVE_WEBKIT_BUNDLE_DIR")" ]
  case ":$LD_LIBRARY_PATH:" in *":$(readlink -f "$WAVE_WEBKIT_BUNDLE_DIR"):"*) ;; *) exit 1 ;; esac
fi
test -f "$dir/libwebkit2gtk-4.1.so.0"
printf '%s\n' "$dir" > "$HOME/override-dir"
printf '%s\n' "$@" > "$HOME/override-args"
MOCK
  chmod +x "$work/launcher/"*
  for helper in WebKitNetworkProcess WebKitWebProcess; do
    printf '#!/bin/sh\nexit 0\n' > "$work/helpers/custom/$helper"
    chmod +x "$work/helpers/custom/$helper"
  done
  : > "$work/bundle/libwebkit2gtkinjectedbundle.so"
  printf '\000/usr/libexec/webkit2gtk-4.1\000/usr/lib/webkit2gtk-4.1/injected-bundle/\000' > "$work/libwebkit.so"
  WAVE_WEBKIT_LIBRARY="$work/libwebkit.so" \
    WAVE_WEBKIT_HELPER_DIR="$work/helpers/custom" \
    WAVE_WEBKIT_BUNDLE_DIR="$work/bundle" \
    "$work/launcher/wave" 'argument with spaces'
  grep -qx 'argument with spaces' "$HOME/override-args"
  [ ! -e "$(cat "$HOME/override-dir")" ]
  WAVE_WEBKIT_LIBRARY="$work/libwebkit.so" \
    WAVE_WEBKIT_HELPER_DIR="$work/helpers/custom" \
    "$work/launcher/wave" helper-only
  grep -qx helper-only "$HOME/override-args"
  WAVE_WEBKIT_LIBRARY="$work/libwebkit.so" \
    WAVE_WEBKIT_BUNDLE_DIR="$work/bundle" \
    "$work/launcher/wave" bundle-only
  grep -qx bundle-only "$HOME/override-args"
  mkdir "$work/helpers:colon"
  cp "$work/helpers/custom/"* "$work/helpers:colon/"
  if WAVE_WEBKIT_LIBRARY="$work/libwebkit.so" \
    WAVE_WEBKIT_HELPER_DIR="$work/helpers:colon" \
    "$work/launcher/wave"; then
    printf 'WebKit helper paths containing colons unexpectedly succeeded\n' >&2
    exit 1
  fi
  cat > "$work/launcher/wave-bin" <<'MOCK'
#!/bin/sh
dir="${LD_LIBRARY_PATH%%:*}"
trap 'sleep 1; test -f "$dir/libwebkit2gtk-4.1.so.0" || exit 71; printf terminated > "$HOME/terminated"; exit 0' TERM
printf '%s\n' "$dir" > "$HOME/signal-dir"
while :; do sleep 1; done
MOCK
  chmod +x "$work/launcher/wave-bin"
  WAVE_WEBKIT_LIBRARY="$work/libwebkit.so" \
    WAVE_WEBKIT_HELPER_DIR="$work/helpers/custom" \
    "$work/launcher/wave" &
  launcher_pid=$!
  attempt=0
  while [ ! -f "$HOME/signal-dir" ] && [ "$attempt" -lt 20 ]; do
    sleep 1
    attempt=$((attempt + 1))
  done
  [ -f "$HOME/signal-dir" ] || { kill "$launcher_pid" 2>/dev/null || true; exit 1; }
  kill -TERM "$launcher_pid"
  status=0
  wait "$launcher_pid" || status=$?
  [ "$status" -eq 143 ] && [ -f "$HOME/terminated" ] && [ ! -e "$(cat "$HOME/signal-dir")" ]
  if WAVE_WEBKIT_LIBRARY="$work/libwebkit.so" \
    WAVE_WEBKIT_HELPER_DIR="$work/helpers/custom" \
    WAVE_WEBKIT_HELPER_TARGET=/wrong/path \
    "$work/launcher/wave"; then
    printf 'incorrect compiled-in helper path unexpectedly succeeded\n' >&2
    exit 1
  fi
  rm "$work/helpers/custom/WebKitWebProcess"
  if WAVE_WEBKIT_LIBRARY="$work/libwebkit.so" \
    WAVE_WEBKIT_HELPER_DIR="$work/helpers/custom" \
    "$work/launcher/wave"; then
    printf 'incomplete helper directory unexpectedly succeeded\n' >&2
    exit 1
  fi
  rm "$work/bundle/libwebkit2gtkinjectedbundle.so"
  if WAVE_WEBKIT_LIBRARY="$work/libwebkit.so" \
    WAVE_WEBKIT_BUNDLE_DIR="$work/bundle" \
    "$work/launcher/wave"; then
    printf 'incomplete injected bundle directory unexpectedly succeeded\n' >&2
    exit 1
  fi
  printf 'helper and injected bundle overrides use a private relocated library\n'
else
  printf 'helper override test skipped: python3 is unavailable\n'
fi
