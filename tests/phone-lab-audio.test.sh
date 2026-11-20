#!/bin/sh
set -eu

work="$(mktemp -d)"
capture=""
cleanup() {
  if [ -n "$capture" ]; then
    kill "$capture" 2>/dev/null || true
    wait "$capture" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

attempt=0
while [ "$attempt" -lt 240 ]; do
  if xdotool search --onlyvisible --name '^Wave$' >/dev/null 2>&1 && \
    pactl list short sinks 2>/dev/null | grep -q wave_lab; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$attempt" -lt 240 ] || { printf 'Phone lab did not start\n' >&2; exit 1; }

curl --silent --max-time 30 -o "$work/audio.mp3" http://127.0.0.1:6082/stream.mp3 &
capture=$!
sleep 3
ffmpeg -nostdin -v error -f lavfi -i sine=frequency=440:duration=6 -f pulse wave_lab
sleep 3
kill "$capture" 2>/dev/null || true
wait "$capture" 2>/dev/null || true
capture=""
ffmpeg -nostdin -v error -i "$work/audio.mp3" -ac 1 -ar 8000 -f s16le "$work/audio.raw"
python3 - "$work/audio.raw" <<'PY'
import array
import sys

samples = array.array("h")
with open(sys.argv[1], "rb") as source:
    samples.frombytes(source.read())
if not samples or max(abs(sample) for sample in samples) < 256:
    raise SystemExit("phone lab audio stream is silent")
PY
printf 'Phone lab streamed audible audio\n'
