#!/bin/sh
set -eu

source_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
root="$work/project"
mkdir -p "$root/scripts" "$root/src-tauri/tools" "$root/src-tauri/icons" "$work/bin" "$work/target/release" "$work/log"
cp "$source_root/scripts/flatpak-build.sh" "$source_root/scripts/flatpak.desktop" "$root/scripts/"
cp "$source_root/src-tauri/icons/128x128.png" "$source_root/src-tauri/icons/128x128@2x.png" "$root/src-tauri/icons/"
cp "$source_root/LICENSE" "$root/LICENSE"
printf '1.2.3\n' > "$root/VERSION"
printf 'wave executable\n' > "$work/target/release/wave"
for tool in yt-dlp ffmpeg ffprobe deno; do
  printf '%s executable\n' "$tool" > "$root/src-tauri/tools/$tool"
done

cat > "$work/bin/flatpak" <<'MOCK'
#!/bin/sh
set -eu
command="$1"
shift
case "$command" in
  --default-arch)
    printf 'aarch64\n'
    ;;
  build-init)
    [ "$#" -eq 5 ]
    [ "$2" = com.wave.app ]
    [ "$3" = org.gnome.Platform ]
    [ "$4" = org.gnome.Platform ]
    [ "$5" = 51 ]
    mkdir -p "$1/files"
    ;;
  build-finish)
    app="$1"
    shift
    printf '%s\n' "$@" > "$FLATPAK_TEST_LOG/finish"
    for tool in wave yt-dlp ffmpeg ffprobe deno; do
      [ -x "$app/files/bin/$tool" ]
      cmp "$app/files/bin/$tool" "$(if [ "$tool" = wave ]; then printf '%s/release/wave' "$CARGO_TARGET_DIR"; else printf 'src-tauri/tools/%s' "$tool"; fi)"
    done
    cmp scripts/flatpak.desktop "$app/files/share/applications/com.wave.app.desktop"
    cmp src-tauri/icons/128x128.png "$app/files/share/icons/hicolor/128x128/apps/com.wave.app.png"
    cmp src-tauri/icons/128x128@2x.png "$app/files/share/icons/hicolor/256x256/apps/com.wave.app.png"
    cmp LICENSE "$app/files/share/licenses/com.wave.app/LICENSE"
    ;;
  build-export)
    [ "$#" -eq 3 ]
    [ "$3" = stable ]
    printf '%s\n' "$2" > "$FLATPAK_TEST_LOG/stage"
    mkdir -p "$1"
    ;;
  build-bundle)
    [ "$#" -eq 6 ]
    [ "$3" = com.wave.app ]
    [ "$4" = stable ]
    [ "$5" = --arch=aarch64 ]
    [ "$6" = --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo ]
    printf 'bundle\n' > "$2"
    ;;
  *)
    exit 1
    ;;
esac
MOCK
chmod +x "$work/bin/flatpak"
export FLATPAK_TEST_LOG="$work/log"
export CARGO_TARGET_DIR="$work/target"
export PATH="$work/bin:$PATH"
sh "$root/scripts/flatpak-build.sh"
test -s "$work/target/flatpak/Wave_1.2.3_aarch64_phone.flatpak"
test ! -e "$(cat "$work/log/stage")"
for option in --command=wave --sdk=org.gnome.Sdk --share=ipc --share=network \
  --socket=wayland --socket=fallback-x11 --socket=pulseaudio --device=dri \
  --filesystem=home --own-name=org.mpris.MediaPlayer2.wave \
  --talk-name=org.freedesktop.Notifications --env=GTK_USE_PORTAL=1; do
  grep -Fx -- "$option" "$work/log/finish" >/dev/null
done

rm "$root/src-tauri/tools/deno"
if sh "$root/scripts/flatpak-build.sh" > "$work/missing.log" 2>&1; then
  printf 'Packaging succeeded without a required tool\n' >&2
  exit 1
fi
