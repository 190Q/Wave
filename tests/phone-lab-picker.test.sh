#!/bin/sh
set -eu

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

window=""
for attempt in $(seq 1 240); do
  window="$(xdotool search --onlyvisible --name '^Wave$' | sed -n '1p')"
  if [ -n "$window" ]; then
    xwd -silent -id "$window" -out "$work/window.xwd"
    colours="$(magick "$work/window.xwd" -format '%k' info:)"
    [ "$colours" -le 30 ] || break
  fi
  [ "$attempt" -lt 240 ] || { printf 'Phone lab did not render Wave\n' >&2; exit 1; }
  sleep 1
done
sleep 2
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
  [ "$attempt" -lt 60 ] || { printf 'The lab import panel did not visibly open\n' >&2; exit 1; }
  sleep 1
done
xdotool mousemove --window "$window" 65 178 click 1
picker=""
for attempt in $(seq 1 120); do
  picker="$(xdotool search --onlyvisible --name '^xdg-desktop-portal-phosh$' | sed -n '1p')"
  [ -z "$picker" ] || break
  sleep 1
done
[ -n "$picker" ] || { printf 'The lab folder picker did not open\n' >&2; exit 1; }
for attempt in $(seq 1 60); do
  xwd -silent -id "$picker" -out "$work/picker.xwd"
  colours="$(magick "$work/picker.xwd" -format '%k' info:)"
  [ "$colours" -le 30 ] || break
  [ "$attempt" -lt 60 ] || { printf 'The lab folder picker rendered blank (%s colours)\n' "$colours" >&2; exit 1; }
  sleep 1
done
printf 'Phone lab folder picker rendered (%s colours)\n' "$colours"
