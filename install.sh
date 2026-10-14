#!/bin/sh
# Wave installer for Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/190Q/Wave/main/install.sh | sh
#
# Save the file to use the flags:
#   sh install.sh --help
set -eu

REPO="190Q/Wave"
PKG="wave"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Wave installer for Linux.

  --version <v>   install a specific version (default: the latest release)
  --dir <path>    prefix for an AppImage install (default: $HOME/.local)
  --uninstall     remove an installed copy
  -h, --help      show this message

Environment:
  WAVE_VERSION    same as --version
  WAVE_PREFIX     same as --dir
USAGE
}

command -v curl >/dev/null 2>&1 || die "curl is required"

VERSION="${WAVE_VERSION:-}"
PREFIX="${WAVE_PREFIX:-$HOME/.local}"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; PREFIX="$2"; shift 2 ;;
    --dir=*) PREFIX="${1#*=}"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

remove_appimage() {
  rm -f "$PREFIX/bin/wave"
  rm -f "$HOME/.local/share/applications/wave.desktop"
  say "Removed the AppImage install from $PREFIX/bin."
}

if [ "$UNINSTALL" -eq 1 ]; then
  if command -v dpkg >/dev/null 2>&1 && dpkg -s "$PKG" >/dev/null 2>&1; then
    sudo apt-get remove -y "$PKG" 2>/dev/null || sudo dpkg -r "$PKG"
    say "Removed the Wave package."
  elif command -v rpm >/dev/null 2>&1 && rpm -q "$PKG" >/dev/null 2>&1; then
    sudo dnf remove -y "$PKG" 2>/dev/null || sudo rpm -e "$PKG"
    say "Removed the Wave package."
  else
    remove_appimage
  fi
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64)   DEB=amd64; RPM=x86_64;  APPIMAGE=amd64 ;;
  aarch64|arm64)  DEB=arm64; RPM=aarch64; APPIMAGE=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

if [ -z "$VERSION" ]; then
  say "Looking up the latest release..."
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest") || die "could not reach GitHub"
  VERSION="${latest##*/v}"
fi
VERSION="${VERSION#v}"
[ -n "$VERSION" ] || die "could not work out which version to install"

say "Installing Wave $VERSION"

# The asset names are read from the release rather than guessed, so a change in
# how the bundles are named cannot quietly break this script.
json=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/v$VERSION") \
  || die "could not read the v$VERSION release"

asset() { # $1: suffix to match, $2: architecture token
  printf '%s\n' "$json" \
    | grep -o '"browser_download_url":[[:space:]]*"[^"]*"' \
    | sed -e 's/.*"\(https[^"]*\)".*/\1/' \
    | grep -E "$1" \
    | grep -F "$2" \
    | head -n 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() { # $1: url, $2: destination
  say "Downloading $(basename "$1")"
  curl -fL --progress-bar "$1" -o "$2" || die "could not download $1"
}

deb="$(asset '\.deb$' "$DEB")"
rpm="$(asset '\.rpm$' "$RPM")"
appimage="$(asset '\.AppImage$' "$APPIMAGE")"

if [ -n "$deb" ] && command -v dpkg >/dev/null 2>&1; then
  fetch "$deb" "$TMP/wave.deb"
  say "Installing the package (this needs sudo)"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y "$TMP/wave.deb" || die "apt-get could not install the package"
  else
    sudo dpkg -i "$TMP/wave.deb" || die "dpkg could not install the package"
  fi
  say "Wave $VERSION installed. Launch it with: wave"
elif [ -n "$rpm" ] && command -v rpm >/dev/null 2>&1; then
  fetch "$rpm" "$TMP/wave.rpm"
  say "Installing the package (this needs sudo)"
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "$TMP/wave.rpm" || die "dnf could not install the package"
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper --non-interactive install "$TMP/wave.rpm" || die "zypper could not install the package"
  else
    sudo rpm -U "$TMP/wave.rpm" || die "rpm could not install the package"
  fi
  say "Wave $VERSION installed. Launch it with: wave"
elif [ -n "$appimage" ]; then
  # No root, no package manager: the AppImage goes somewhere on the PATH.
  mkdir -p "$PREFIX/bin"
  fetch "$appimage" "$PREFIX/bin/wave"
  chmod +x "$PREFIX/bin/wave"

  # A menu entry, so it shows up in the launcher like a packaged build would.
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/wave.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Wave
Comment=A local-first music player
Exec=$PREFIX/bin/wave
Terminal=false
Categories=Audio;Music;Player;AudioVideo;
DESKTOP

  say "Wave $VERSION installed to $PREFIX/bin/wave"
  case ":$PATH:" in
    *":$PREFIX/bin:"*) ;;
    *) warn "$PREFIX/bin is not on your PATH; add it, or run $PREFIX/bin/wave directly." ;;
  esac
else
  die "the v$VERSION release has no package for this architecture"
fi
