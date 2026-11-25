#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
cd "$root"
version="$(tr -d '\r\n' < VERSION)"
arch="$(flatpak --default-arch)"
target="${CARGO_TARGET_DIR:-$root/src-tauri/target}"
binary="$target/release/wave"
output="$target/flatpak/Wave_${version}_${arch}_phone.flatpak"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

flatpak build-init "$stage/app" com.wave.app org.gnome.Platform org.gnome.Platform 51
install -Dm755 "$binary" "$stage/app/files/bin/wave"
for tool in yt-dlp ffmpeg ffprobe deno; do
  install -Dm755 "src-tauri/tools/$tool" "$stage/app/files/bin/$tool"
done
install -Dm644 scripts/flatpak.desktop "$stage/app/files/share/applications/com.wave.app.desktop"
install -Dm644 scripts/com.wave.app.metainfo.xml "$stage/app/files/share/metainfo/com.wave.app.metainfo.xml"
install -Dm644 src-tauri/icons/128x128.png "$stage/app/files/share/icons/hicolor/128x128/apps/com.wave.app.png"
install -Dm644 src-tauri/icons/128x128@2x.png "$stage/app/files/share/icons/hicolor/256x256/apps/com.wave.app.png"
install -Dm644 LICENSE "$stage/app/files/share/licenses/com.wave.app/LICENSE"

flatpak build-finish "$stage/app" \
  --command=wave --sdk=org.gnome.Sdk \
  --share=ipc --share=network \
  --socket=wayland --socket=fallback-x11 --socket=pulseaudio \
  --device=dri --filesystem=home \
  --own-name=org.mpris.MediaPlayer2.wave \
  --talk-name=org.freedesktop.Notifications \
  --talk-name=org.gnome.ScreenSaver \
  --env=GTK_USE_PORTAL=1
flatpak build-export "$stage/repo" "$stage/app" stable
mkdir -p "$(dirname "$output")"
flatpak build-bundle "$stage/repo" "$output" com.wave.app stable \
  --arch="$arch" --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo
printf 'Wrote %s\n' "$output"
