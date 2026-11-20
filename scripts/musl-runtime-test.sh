#!/bin/sh
set -eu

version="$(tr -d '\r\n' < VERSION)"
archive="$PWD/src-tauri/target/musl/Wave_${version}_aarch64_musl.tar.gz"
test -f "$archive"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
mkdir -p "$temp/bin"
adduser -D wave-smoke
export HOME="/home/wave-smoke"
export PATH="$temp/bin:$PATH"
export WAVE_TEST_ARCHIVE="$archive"
export WAVE_TEST_VERSION="$version"

cat > "$temp/bin/curl" <<'MOCK'
#!/bin/sh
case "$*" in
  *api.github.com*)
    printf '{"browser_download_url": "https://example.test/Wave_%s_aarch64_musl.tar.gz"}\n' "$WAVE_TEST_VERSION"
    exit
    ;;
esac
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then
    cp "$WAVE_TEST_ARCHIVE" "$2"
    exit
  fi
  shift
done
exit 1
MOCK
chmod +x "$temp/bin/curl"

sh install.sh --version "$version"
if ! ldd "$HOME/.local/bin/wave-bin" > "$temp/ldd.log" 2>&1; then
  cat "$temp/ldd.log" >&2
  exit 1
fi
if grep -E 'not found|Error loading' "$temp/ldd.log"; then
  exit 1
fi
"$HOME/.local/bin/wave" --version
"$HOME/.local/bin/wave" help > "$temp/help"
grep -q 'import' "$temp/help"
for package in yt-dlp ffmpeg deno yt-dlp-ejs-rt-deno glib-networking mesa-dri-gallium mesa-gles xdg-desktop-portal-phosh; do
  apk info -e "$package" >/dev/null
done

apk add --no-cache xvfb-run dbus xwd imagemagick font-dejavu pulseaudio pulseaudio-utils
chown -R wave-smoke:wave-smoke "$HOME"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
su -s /bin/sh wave-smoke -c \
  'if [ "${WAVE_TEST_WEBKIT_SANDBOX:-0}" = 1 ]; then export WEBKIT_FORCE_SANDBOX=1; else export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1; fi; export LIBGL_ALWAYS_SOFTWARE=1 GDK_BACKEND=x11; xvfb-run -a -s "-screen 0 360x720x24" dbus-run-session -- sh /wave/scripts/musl-gui-test.sh'

sh install.sh --uninstall
test ! -e "$HOME/.local/bin/wave"
test ! -e "$HOME/.local/bin/wave-bin"
test ! -e "$HOME/.local/bin/wave-webkit.py"
