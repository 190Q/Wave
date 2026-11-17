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
printf '1000\n'
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
cat > "$work/archive/wave-bin" <<'MOCK'
#!/bin/sh
printf '%s\n' "$@" > "$HOME/launched"
MOCK
chmod +x "$work/archive/wave" "$work/archive/wave-bin"
tar -czf "$MOCK_ARCHIVE" -C "$work/archive" wave wave-bin
cat > "$MOCK_JSON" <<'JSON'
{"browser_download_url": "https://example.test/Wave_1.2.3_aarch64_musl.tar.gz"}
{"browser_download_url": "https://example.test/Wave_1.2.3_aarch64.AppImage"}
{"browser_download_url": "https://example.test/Wave_1.2.3_arm64.deb"}
JSON

prefix="$work/custom prefix"
sh "$root/install.sh" --version 1.2.3 --dir "$prefix"
grep -q 'apk add .*webkit2gtk-4.1' "$MOCK_LOG"
grep -q 'gst-plugins-good' "$MOCK_LOG"
[ -x "$prefix/bin/wave" ] && [ -x "$prefix/bin/wave-bin" ]
grep -Fq "Exec=\"$prefix/bin/wave\"" "$HOME/.local/share/applications/wave.desktop"
"$prefix/bin/wave" help
grep -qx help "$HOME/launched"
sh "$root/install.sh" --dir "$prefix" --uninstall
[ ! -e "$prefix/bin/wave" ] && [ ! -e "$prefix/bin/wave-bin" ]
[ ! -e "$HOME/.local/share/applications/wave.desktop" ]
printf 'musl installation, launch, and uninstall passed\n'

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
MOCK_LIBC=glibc sh "$root/install.sh" --version 1.2.3 --dir "$appimage_prefix"
[ -x "$appimage_prefix/bin/wave" ]
[ ! -e "$appimage_prefix/bin/wave-bin" ]
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

if command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / -- /bin/true 2>/dev/null; then
  mkdir -p "$work/launcher" "$work/helpers/custom"
  cp "$root/scripts/musl-launcher.sh" "$work/launcher/wave"
  cat > "$work/launcher/wave-bin" <<'MOCK'
#!/bin/sh
[ "$(cat "$WAVE_TEST_PARENT/keep")" = preserved ]
[ -x "$WAVE_WEBKIT_HELPER_TARGET/WebKitNetworkProcess" ]
[ -x "$WAVE_WEBKIT_HELPER_TARGET/WebKitWebProcess" ]
printf '%s\n' "$@" > "$HOME/override-args"
MOCK
  chmod +x "$work/launcher/"*
  printf 'preserved\n' > "$work/helpers/keep"
  for helper in WebKitNetworkProcess WebKitWebProcess; do
    printf '#!/bin/sh\nexit 0\n' > "$work/helpers/custom/$helper"
    chmod +x "$work/helpers/custom/$helper"
  done
  WAVE_TEST_PARENT="$work/helpers" \
    WAVE_WEBKIT_HELPER_DIR="$work/helpers/custom" \
    WAVE_WEBKIT_HELPER_TARGET="$work/helpers/webkit" \
    "$work/launcher/wave" 'argument with spaces'
  grep -qx 'argument with spaces' "$HOME/override-args"
  [ ! -e "$work/helpers/webkit" ]
  [ "$(cat "$work/helpers/keep")" = preserved ]
  if WAVE_WEBKIT_HELPER_DIR="$work/helpers/custom" \
    WAVE_WEBKIT_HELPER_TARGET=relative \
    "$work/launcher/wave"; then
    printf 'relative helper target unexpectedly succeeded\n' >&2
    exit 1
  fi
  if TMPDIR="$work/helpers" \
    WAVE_WEBKIT_HELPER_DIR="$work/helpers/custom" \
    WAVE_WEBKIT_HELPER_TARGET="$work/helpers/webkit" \
    "$work/launcher/wave"; then
    printf 'nested temporary directory unexpectedly succeeded\n' >&2
    exit 1
  fi
  rm "$work/helpers/custom/WebKitWebProcess"
  if WAVE_WEBKIT_HELPER_DIR="$work/helpers/custom" \
    WAVE_WEBKIT_HELPER_TARGET="$work/helpers/webkit" \
    "$work/launcher/wave"; then
    printf 'incomplete helper directory unexpectedly succeeded\n' >&2
    exit 1
  fi
  printf 'helper override uses a private mount and preserves arguments\n'
else
  printf 'helper namespace test skipped: bubblewrap is unavailable\n'
fi
