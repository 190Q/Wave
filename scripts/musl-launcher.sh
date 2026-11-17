#!/bin/sh
set -eu

binary="$(dirname "$0")/wave-bin"
source_dir="${WAVE_WEBKIT_HELPER_DIR:-}"

if [ -z "$source_dir" ]; then
  exec "$binary" "$@"
fi

die() { printf 'wave: %s\n' "$*" >&2; exit 1; }
command -v bwrap >/dev/null 2>&1 || die "WAVE_WEBKIT_HELPER_DIR requires bubblewrap"
source_dir="$(readlink -f "$source_dir")" || die "the WebKit helper directory does not exist"
[ -d "$source_dir" ] || die "the WebKit helper directory does not exist"
for helper in WebKitNetworkProcess WebKitWebProcess; do
  [ -x "$source_dir/$helper" ] || die "$source_dir/$helper is missing or not executable"
done

target="${WAVE_WEBKIT_HELPER_TARGET:-/usr/libexec/webkit2gtk-4.1}"
case "$target" in
  /*) ;;
  *) die "WAVE_WEBKIT_HELPER_TARGET must be an absolute directory path" ;;
esac
name="$(basename "$target")"
case "$name" in
  .|..|/) die "WAVE_WEBKIT_HELPER_TARGET must name a directory" ;;
esac
parent="$(readlink -f "$(dirname "$target")")" || die "the WebKit helper target's parent directory does not exist"
[ -d "$parent" ] || die "the WebKit helper target's parent directory does not exist"
[ "$parent" != / ] || die "the WebKit helper target cannot be directly under /"
target="$parent/$name"
[ "$source_dir" != "$target" ] || exec "$binary" "$@"

temp="$(mktemp -d "${TMPDIR:-/tmp}/wave-webkit.XXXXXX")" || die "could not create a temporary directory"
trap 'rm -rf "$temp"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
case "$(readlink -f "$temp")" in
  "$parent"/*) die "TMPDIR must be outside the WebKit helper target's parent directory" ;;
esac
mkdir "$temp/original" "$temp/overlay" "$temp/overlay/$name"
for entry in "$parent"/* "$parent"/.[!.]* "$parent"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  entry_name="$(basename "$entry")"
  [ "$entry_name" = "$name" ] && continue
  ln -s "$temp/original/$entry_name" "$temp/overlay/$entry_name"
done
bwrap --bind / / \
  --ro-bind "$parent" "$temp/original" \
  --ro-bind "$temp/overlay" "$parent" \
  --ro-bind "$source_dir" "$target" \
  -- "$binary" "$@"
