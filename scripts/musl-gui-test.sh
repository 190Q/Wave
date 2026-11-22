#!/bin/sh
set -eu

wave="$HOME/.local/bin/wave"
work="$(mktemp -d)"
pid=""
server_pid=""
capture_pid=""
wm_pid=""
pulse_started=""
cleanup() {
  if [ -n "$capture_pid" ]; then
    kill "$capture_pid" 2>/dev/null || true
    wait "$capture_pid" 2>/dev/null || true
  fi
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ -n "$wm_pid" ]; then
    kill "$wm_pid" 2>/dev/null || true
    wait "$wm_pid" 2>/dev/null || true
  fi
  if [ -n "$pulse_started" ]; then
    pulseaudio -k 2>/dev/null || true
  fi
  if [ "${WAVE_TEST_KEEP_ARTIFACTS:-0}" = 1 ]; then
    printf 'Graphical test artifacts: %s\n' "$work"
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT

export XDG_RUNTIME_DIR="$work/runtime"
export XDG_CURRENT_DESKTOP=Phosh
export GSK_RENDERER=cairo
mkdir -m 700 "$XDG_RUNTIME_DIR"
mkdir -p "$HOME/.config/xdg-desktop-portal"
printf '[preferred]\ndefault=phosh\n' > "$HOME/.config/xdg-desktop-portal/portals.conf"
dbus-update-activation-environment DISPLAY XDG_RUNTIME_DIR XDG_CURRENT_DESKTOP GSK_RENDERER

"$wave" tools --json > "$work/tools.json"
python3 - "$work/tools.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    tools = json.load(source)
assert tools["ytDlp"] and tools["ffmpeg"] and tools["deno"], tools
PY
yt-dlp --version
deno --version
ffmpeg -version

mkdir "$work/music"
ffmpeg -v error -f lavfi -i sine=frequency=440:duration=180 \
  -metadata title=WaveSmoke -metadata artist=WaveTest "$work/music/smoke.mp3"
mkdir "$HOME/WaveGuiImport"
ffmpeg -v error -f lavfi -i sine=frequency=523:duration=2 \
  -metadata title=WaveGuiImport -metadata artist=WaveTest "$HOME/WaveGuiImport/gui.mp3"
python3 -m http.server 45387 --bind 127.0.0.1 --directory "$work/music" > "$work/http.log" 2>&1 &
server_pid=$!
sleep 1
yt-dlp --ignore-config -o "$work/download.%(ext)s" http://127.0.0.1:45387/smoke.mp3
test -s "$work/download.mp3"
"$wave" import "$work/music" --no-playlist
"$wave" list --json > "$work/songs.json"
python3 - "$work/songs.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    songs = json.load(source)
assert any(song.get("title") == "WaveSmoke" for song in songs), songs
PY

wait_ready() {
  attempt=0
  while [ "$attempt" -lt 180 ]; do
    if [ ! -f "$work/app.log" ]; then
      attempt=$((attempt + 1))
      sleep 1
      continue
    fi
    if grep -Fq 'wave: frontend startup error:' "$work/app.log"; then
      cat "$work/app.log" >&2
      return 1
    fi
    if grep -Fq 'wave: frontend ready (linuxPhone)' "$work/app.log"; then
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  cat "$work/app.log" >&2
  printf 'Wave did not finish loading the phone UI\n' >&2
  exit 1
}

wait_for_exit() {
  for attempt in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      if ! wait "$pid"; then
        cat "$work/app.log" >&2
        printf 'Wave exited with an error after %s\n' "$1" >&2
        exit 1
      fi
      pid=""
      return
    fi
    sleep 1
  done
  cat "$work/app.log" >&2
  printf 'Wave remained running after %s\n' "$1" >&2
  exit 1
}

pulseaudio --start --exit-idle-time=-1
pulse_started=1
pactl load-module module-null-sink sink_name=wave_test >/dev/null
pactl set-default-sink wave_test

"$wave" > "$work/app.log" 2>&1 &
pid=$!
wait_ready
window=""
for attempt in $(seq 1 20); do
  window="$(xdotool search --onlyvisible --name '^Wave$' | sed -n '1p')"
  [ -z "$window" ] || break
  sleep 1
done
[ -n "$window" ] || { cat "$work/app.log" >&2; printf 'Wave has no visible window\n' >&2; exit 1; }
sleep 2
parec --device=wave_test.monitor --format=s16le --rate=8000 --channels=1 > "$work/playback.raw" &
capture_pid=$!
sleep 2
xdotool windowfocus "$window"
xdotool key space
sleep 15
kill "$capture_pid" 2>/dev/null || true
wait "$capture_pid" 2>/dev/null || true
capture_pid=""
if ! python3 - "$work/playback.raw" <<'PY'
import array
import sys

samples = array.array("h")
with open(sys.argv[1], "rb") as source:
    samples.frombytes(source.read())
if not samples or max(abs(sample) for sample in samples) < 256:
    raise SystemExit("Wave did not produce audible audio")
PY
then
  cat "$work/app.log" >&2
  exit 1
fi
if [ "${WAVE_TEST_MPRIS_PLAYBACK:-1}" = 1 ]; then
  python3 "$(dirname "$0")/test-mpris.py" wave_test.monitor WaveSmoke
else
  xdotool key space
  sleep 1
fi
xwd -silent -id "$window" -out "$work/window.xwd"
colours="$(magick "$work/window.xwd" -format '%k' info:)"
[ "$colours" -gt 30 ] || { printf 'Wave rendered an almost blank window (%s colours)\n' "$colours" >&2; exit 1; }
xdotool windowfocus "$window"
xdotool key i
for attempt in $(seq 1 60); do
  xwd -silent -id "$window" -out "$work/import.xwd"
  metric="$(magick compare -metric AE "$work/window.xwd" "$work/import.xwd" null: 2>&1 || true)"
  changed="${metric%% *}"
  case "$changed" in
    ''|*[!0-9]*) printf 'Could not compare the import screenshots: %s\n' "$metric" >&2; exit 1 ;;
  esac
  [ "$changed" -le 20000 ] || break
  [ "$attempt" -lt 60 ] || { printf 'The phone import panel did not visibly open\n' >&2; exit 1; }
  sleep 1
done
xdotool mousemove --window "$window" 65 178 click 1
picker=""
for attempt in $(seq 1 120); do
  picker="$(xdotool search --onlyvisible --name '^xdg-desktop-portal-phosh$' | sed -n '1p')"
  [ -z "$picker" ] || break
  sleep 1
done
[ -n "$picker" ] || { cat "$work/app.log" >&2; printf 'The folder picker did not open\n' >&2; exit 1; }
eval "$(xdotool getwindowgeometry --shell "$picker")"
if [ "$X" -lt 0 ] || [ "$Y" -lt 0 ] || [ $((X + WIDTH)) -gt 360 ] || [ $((Y + HEIGHT)) -gt 720 ]; then
  printf 'The folder picker does not fit on the phone screen: %sx%s at %s,%s\n' "$WIDTH" "$HEIGHT" "$X" "$Y" >&2
  exit 1
fi
for attempt in $(seq 1 60); do
  xwd -silent -id "$picker" -out "$work/picker.xwd"
  colours="$(magick "$work/picker.xwd" -format '%k' info:)"
  [ "$colours" -le 30 ] || break
  [ "$attempt" -lt 60 ] || { printf 'The folder picker rendered blank (%s colours)\n' "$colours" >&2; exit 1; }
  sleep 1
done
sleep 2
xdotool mousemove --window "$picker" 65 105 click --repeat 2 --delay 150 1
sleep 2
xdotool mousemove --window "$picker" 315 28 click 1
for attempt in $(seq 1 60); do
  xdotool search --onlyvisible --name '^xdg-desktop-portal-phosh$' >/dev/null || break
  sleep 1
done
if xdotool search --onlyvisible --name '^xdg-desktop-portal-phosh$' >/dev/null; then
  printf 'The folder picker did not accept the selected folder\n' >&2
  exit 1
fi
sleep 2
xdotool mousemove --window "$window" 160 431 click 1
for attempt in $(seq 1 120); do
  "$wave" list --json > "$work/gui-songs.json"
  if python3 - "$work/gui-songs.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    songs = json.load(source)
raise SystemExit(0 if any(song.get("title") == "WaveGuiImport" for song in songs) else 1)
PY
  then
    break
  fi
  [ "$attempt" -lt 120 ] || { cat "$work/app.log" >&2; printf 'GUI folder import did not add the song\n' >&2; exit 1; }
  sleep 1
done
xdotool key Escape
sleep 1
xdotool mousemove --window "$window" 38 35 click 1
for attempt in $(seq 1 60); do
  xwd -silent -id "$window" -out "$work/library.xwd"
  metric="$(magick compare -metric AE "$work/window.xwd" "$work/library.xwd" null: 2>&1 || true)"
  changed="${metric%% *}"
  case "$changed" in
    ''|*[!0-9]*) printf 'Could not compare the phone screenshots: %s\n' "$metric" >&2; exit 1 ;;
  esac
  [ "$changed" -le 5000 ] || break
  [ "$attempt" -lt 60 ] || { printf 'The library button did not visibly open the library\n' >&2; exit 1; }
  sleep 1
done
fluxbox -no-toolbar -log "$work/fluxbox.log" &
wm_pid=$!
sleep 2
xdotool windowfocus "$window"
xdotool key alt+F4
wait_for_exit "the window was closed"

mkdir "$work/helpers with spaces" "$work/injected bundle"
for name in WebKitWebProcess WebKitNetworkProcess WebKitGPUProcess; do
  [ ! -f "/usr/libexec/webkit2gtk-4.1/$name" ] || cp "/usr/libexec/webkit2gtk-4.1/$name" "$work/helpers with spaces/$name"
done
cp /usr/lib/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so "$work/injected bundle/"
WAVE_WEBKIT_HELPER_DIR="$work/helpers with spaces" \
  WAVE_WEBKIT_BUNDLE_DIR="$work/injected bundle" \
  "$wave" > "$work/app.log" 2>&1 &
pid=$!
wait_ready

if ! python3 "$(dirname "$0")/check-webkit-paths.py" "$work" "$pid"; then
  cat "$work/app.log" >&2
  exit 1
fi

if [ -n "${WAVE_TEST_YOUTUBE_URL:-}" ]; then
  "$wave" import "$WAVE_TEST_YOUTUBE_URL"
fi
if grep -Fq 'wave: frontend startup error:' "$work/app.log"; then
  cat "$work/app.log" >&2
  exit 1
fi
if [ "${WAVE_TEST_MPRIS_QUIT:-1}" = 1 ]; then
  for attempt in $(seq 1 60); do
    if gdbus call --session --dest org.mpris.MediaPlayer2.wave \
      --object-path /org/mpris/MediaPlayer2 --method org.freedesktop.DBus.Properties.Get \
      org.mpris.MediaPlayer2 CanQuit >/dev/null 2>&1; then
      break
    fi
    [ "$attempt" -lt 60 ] || { cat "$work/app.log" >&2; printf 'Wave did not register its media controls\n' >&2; exit 1; }
    sleep 1
  done
  gdbus call --session --dest org.mpris.MediaPlayer2.wave \
    --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Quit
  wait_for_exit "the media controls requested quit"
else
  window="$(xdotool search --onlyvisible --name '^Wave$' | sed -n '1p')"
  xdotool windowfocus "$window"
  xdotool key alt+F4
  wait_for_exit "the window was closed"
fi
printf 'Installed phone package rendered the UI, imported through the phone picker, played audio, used the custom WebKit paths, and exited on close\n'
