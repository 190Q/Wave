#!/bin/sh
set -eu

window_class="$(xprop -id "$1" WM_CLASS | sed -n 's/^WM_CLASS(STRING) = "[^"]*", "\([^"]*\)"$/\1/p')"
[ -n "$window_class" ] && [ "$window_class" = "$2" ] || {
  printf 'Wave window class %s does not match %s\n' "$window_class" "$2" >&2
  exit 1
}
