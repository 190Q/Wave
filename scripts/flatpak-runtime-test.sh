#!/bin/sh
set -eu

work="$HOME/WaveFlatpakSmoke-$$"
pid=""
capture=""
pulse=""
mkdir -p "$work/music" "$work/runtime"
chmod 700 "$work/runtime"
export XDG_RUNTIME_DIR="$work/runtime"
export PULSE_RUNTIME_PATH="$work/runtime/pulse"
export PULSE_SERVER="unix:$PULSE_RUNTIME_PATH/native"
export GDK_BACKEND=x11
export LIBGL_ALWAYS_SOFTWARE=1
dbus-update-activation-environment DISPLAY XDG_RUNTIME_DIR

cleanup() {
  if [ -n "$capture" ]; then
    kill "$capture" 2>/dev/null || true
    wait "$capture" 2>/dev/null || true
  fi
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [ -n "$pulse" ]; then
    kill "$pulse" 2>/dev/null || true
    wait "$pulse" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

wave() { flatpak run com.wave.app "$@"; }

flatpak run --command=yt-dlp com.wave.app --version
flatpak run --command=deno com.wave.app --version
flatpak run --command=ffmpeg com.wave.app -version
flatpak run --command=ffprobe com.wave.app -version
wave tools --json > "$work/tools.json"
python3 - "$work/tools.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    tools = json.load(source)
assert tools["ytDlp"] and tools["ffmpeg"] and tools["deno"], tools
PY

flatpak run --command=ffmpeg com.wave.app -v error -f lavfi -i sine=frequency=440:duration=180 \
  -metadata title=WaveFlatpakSmoke "$work/music/smoke.mp3"
wave import "$work/music" --no-playlist
wave list --json > "$work/songs.json"
python3 - "$work/songs.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    songs = json.load(source)
assert any(song.get("title") == "WaveFlatpakSmoke" for song in songs), songs
PY

pulseaudio --daemonize=no --exit-idle-time=-1 > "$work/pulse.log" 2>&1 &
pulse=$!
for attempt in $(seq 1 30); do
  if pactl info >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$pulse" 2>/dev/null || [ "$attempt" -eq 30 ]; then
    cat "$work/pulse.log" >&2
    printf 'The test audio server did not start\n' >&2
    exit 1
  fi
  sleep 1
done
pactl load-module module-null-sink sink_name=wave_flatpak_test >/dev/null
pactl set-default-sink wave_flatpak_test
wave > "$work/app.log" 2>&1 &
pid=$!
for attempt in $(seq 1 180); do
  if grep -Fq 'wave: frontend ready (linuxPhone)' "$work/app.log"; then
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null || [ "$attempt" -eq 180 ]; then
    cat "$work/app.log" >&2
    printf 'The Flatpak phone interface did not load\n' >&2
    exit 1
  fi
  sleep 1
done
window=""
for attempt in $(seq 1 20); do
  window="$(xdotool search --onlyvisible --name '^Wave$' | sed -n '1p')"
  [ -z "$window" ] || break
  sleep 1
done
[ -n "$window" ] || { cat "$work/app.log" >&2; printf 'Wave has no visible window\n' >&2; exit 1; }
parec --device=wave_flatpak_test.monitor --format=s16le --rate=8000 --channels=1 > "$work/playback.raw" &
capture=$!
sleep 2
xdotool windowfocus "$window"
xdotool key space
sleep 15
kill "$capture" 2>/dev/null || true
wait "$capture" 2>/dev/null || true
capture=""
python3 - "$work/playback.raw" <<'PY'
import array
import sys
samples = array.array("h")
with open(sys.argv[1], "rb") as source:
    samples.frombytes(source.read())
if not samples or max(abs(sample) for sample in samples) < 256:
    raise SystemExit("The Flatpak did not produce audible audio")
PY

python3 "$(dirname "$0")/test-mpris.py" wave_flatpak_test.monitor WaveFlatpakSmoke

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
for attempt in $(seq 1 60); do
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    pid=""
    break
  fi
  [ "$attempt" -lt 60 ] || { cat "$work/app.log" >&2; printf 'Wave did not exit after the media controls requested quit\n' >&2; exit 1; }
  sleep 1
done
printf 'The phone Flatpak opened, imported music, played audio and exposed media controls\n'
