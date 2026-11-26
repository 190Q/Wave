#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
xmessage -name wave-regression -title WaveClassTest 'Wave class test' &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
window=""
for attempt in $(seq 1 30); do
  window="$(xdotool search --onlyvisible --name '^WaveClassTest$' | sed -n '1p')" || true
  [ -z "$window" ] || break
  sleep 1
done
[ -n "$window" ] || { printf 'The X11 test window did not open\n' >&2; exit 1; }
sh "$root/scripts/check-window-class.sh" "$window" Xmessage
if sh "$root/scripts/check-window-class.sh" "$window" wave-regression; then
  printf 'The window instance unexpectedly matched its class\n' >&2
  exit 1
fi
if sh "$root/scripts/check-window-class.sh" "$window" xmessage; then
  printf 'The class comparison was not case-sensitive\n' >&2
  exit 1
fi
