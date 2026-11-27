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
  --dir <path>    prefix for an AppImage or musl install (default: $HOME/.local)
  --local         install the extracted phone tarball beside this script
  --install-deps  install missing phone dependencies with apk without prompting
  --skip-deps     leave phone dependencies for manual installation
  --uninstall     remove an installed copy
  -h, --help      show this message

Environment:
  WAVE_VERSION             same as --version
  WAVE_PREFIX              same as --dir
  WAVE_WEBKIT_HELPER_DIR   WebKit helper executable directory when launching Wave
  WAVE_WEBKIT_BUNDLE_DIR   WebKit injected-bundle directory when launching Wave
  WAVE_WEBKIT_LIBRARY      WebKit library file if automatic discovery fails
  WAVE_WEBKIT_HELPER_TARGET  compiled-in helper path if automatic discovery fails
  WAVE_WEBKIT_BUNDLE_TARGET  compiled-in bundle path if automatic discovery fails
USAGE
}

VERSION="${WAVE_VERSION:-}"
PREFIX="${WAVE_PREFIX:-$HOME/.local}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
UNINSTALL=0
LOCAL=0
DEPS=ask

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; PREFIX="$2"; shift 2 ;;
    --dir=*) PREFIX="${1#*=}"; shift ;;
    --local) LOCAL=1; shift ;;
    --install-deps) [ "$DEPS" != skip ] || die "--install-deps and --skip-deps cannot be combined"; DEPS=install; shift ;;
    --skip-deps) [ "$DEPS" != install ] || die "--install-deps and --skip-deps cannot be combined"; DEPS=skip; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

remove_appimage() {
  rm -f "$PREFIX/bin/wave"
  if [ -f "$PREFIX/share/wave/musl-install" ]; then
    rm -f "$PREFIX/bin/wave-bin" "$PREFIX/share/wave/musl-install"
    rm -f "$PREFIX/bin/wave-webkit.py"
  fi
  rm -f "$DATA_HOME/applications/wave.desktop" "$DATA_HOME/applications/wave-bin.desktop"
  rm -f "$DATA_HOME/icons/hicolor/scalable/apps/wave-bin.svg" \
    "$DATA_HOME/icons/hicolor/128x128/apps/wave-bin.png" \
    "$DATA_HOME/icons/hicolor/256x256/apps/wave-bin.png"
  say "Removed the local install from $PREFIX/bin."
}

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$PREFIX/share/wave/musl-install" ]; then
    remove_appimage
  elif command -v dpkg >/dev/null 2>&1 && dpkg -s "$PKG" >/dev/null 2>&1; then
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
  aarch64|arm64)  DEB=arm64; RPM=aarch64; APPIMAGE=aarch64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

MUSL=0
if (ldd --version 2>&1 || true) | grep -qi musl; then
  MUSL=1
  [ "$RPM" = aarch64 ] || die "the musl release is only available for aarch64"
  if [ "$DEPS" = install ]; then
    command -v apk >/dev/null 2>&1 || die "--install-deps requires Alpine's apk package manager"
  fi
fi

asset() { # $1: suffix to match, $2: architecture token
  printf '%s\n' "$json" \
    | grep -o '"browser_download_url":[[:space:]]*"[^"]*"' \
    | sed -e 's/.*"\(https[^"]*\)".*/\1/' \
    | grep -E "$1" \
    | grep -F "$2" \
    | grep -v -F -e "-slim" \
    | head -n 1
}

TMP="$(mktemp -d)"
BIN_STAGE=""
trap 'rm -rf "$TMP"; [ -z "$BIN_STAGE" ] || rm -rf "$BIN_STAGE"' EXIT INT TERM

fetch() { # $1: url, $2: destination
  say "Downloading $(basename "$1")"
  curl -fL --progress-bar "$1" -o "$2" || die "could not download $1"
}

deb="" rpm="" appimage="" musl=""
if [ "$LOCAL" -eq 1 ]; then
  [ "$MUSL" -eq 1 ] || die "--local requires an aarch64 musl system"
  local_dir="$(CDPATH= cd -- "${WAVE_LOCAL_PACKAGE_DIR:-$(dirname "$0")}" && pwd -P)"
  if [ -f "$local_dir/VERSION" ]; then
    VERSION="$(tr -d '\r\n' < "$local_dir/VERSION")"
  fi
  VERSION="${VERSION:-unknown}"
else
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if [ -z "$VERSION" ]; then
    say "Looking up the latest release..."
    latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/$REPO/releases/latest") || die "could not reach GitHub"
    VERSION="${latest##*/v}"
  fi
  VERSION="${VERSION#v}"
  [ -n "$VERSION" ] || die "could not work out which version to install"
  json=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/v$VERSION") \
    || die "could not read the v$VERSION release"
  deb="$(asset '\.deb$' "$DEB")"
  rpm="$(asset '\.rpm$' "$RPM")"
  appimage="$(asset '\.AppImage$' "$APPIMAGE")"
  musl="$(asset '_aarch64_musl\.tar\.gz$' '_aarch64_musl')"
fi
say "Installing Wave $VERSION"

desktop_entry() {
  desktop_id="${1:-wave}"
  icon="${2:-}"
  window_class="${3:-}"
  mkdir -p "$DATA_HOME/applications"
  exec_path=$(printf '%s' "$PREFIX/bin/wave" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g; s/%/%%/g')
  cat > "$DATA_HOME/applications/$desktop_id.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Wave
Comment=A local-first music player
Exec="$exec_path"
Terminal=false
Categories=Audio;Music;Player;AudioVideo;
DESKTOP
  if [ -n "$icon" ]; then
    printf 'Icon=%s\nStartupWMClass=%s\n' "$icon" "$window_class" >> "$DATA_HOME/applications/$desktop_id.desktop"
  fi
}

local_installed() {
  say "Wave $VERSION installed to $PREFIX/bin/wave"
  case ":$PATH:" in
    *":$PREFIX/bin:"*) ;;
    *) warn "$PREFIX/bin is not on your PATH; add it, or run $PREFIX/bin/wave directly." ;;
  esac
}

warn_if_root() {
  if [ "$(id -u)" -eq 0 ]; then
    warn "Running as root: the desktop entry and default install use $HOME. Run the installer without sudo or doas to install for your user."
  fi
}

if [ "$MUSL" -eq 1 ]; then
  warn_if_root
  if [ "$LOCAL" -eq 1 ]; then
    [ -f "$local_dir/wave" ] && [ ! -L "$local_dir/wave" ] || die "the phone package is missing wave"
    cp "$local_dir/wave" "$TMP/wave"
    for file in wave-bin wave-webkit.py wave.svg wave-128.png wave-256.png; do
      if [ -e "$local_dir/$file" ] || [ -L "$local_dir/$file" ]; then
        [ -f "$local_dir/$file" ] && [ ! -L "$local_dir/$file" ] || die "the phone package contains an invalid $file"
        cp "$local_dir/$file" "$TMP/$file"
      fi
    done
  else
    [ -n "$musl" ] || die "the v$VERSION release has no aarch64 musl package"
    fetch "$musl" "$TMP/wave.tar.gz"
    tar -xzf "$TMP/wave.tar.gz" -C "$TMP" wave || die "the musl archive does not contain wave"
    for file in wave-bin wave-webkit.py wave.svg wave-128.png wave-256.png; do
      if tar -tzf "$TMP/wave.tar.gz" | grep -Fxq "$file"; then
        tar -xzf "$TMP/wave.tar.gz" -C "$TMP" "$file" || die "could not extract $file"
        [ -f "$TMP/$file" ] && [ ! -L "$TMP/$file" ] || die "the musl archive contains an invalid $file"
      fi
    done
  fi
  [ -f "$TMP/wave" ] && [ ! -L "$TMP/wave" ] || die "the musl archive contains an invalid wave executable"
  if [ -f "$TMP/wave-bin" ] || [ -f "$TMP/wave-webkit.py" ] || grep -Fq 'wave-webkit.py' "$TMP/wave"; then
    [ -f "$TMP/wave-bin" ] && [ -f "$TMP/wave-webkit.py" ] || die "the phone package is incomplete; download it again"
  fi

  packages="webkit2gtk-4.1 libayatana-appindicator librsvg xdotool openssl \
    glib-networking ca-certificates mesa-dri-gallium mesa-gles font-dejavu xdg-desktop-portal-phosh \
    gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav \
    yt-dlp ffmpeg deno yt-dlp-ejs-rt-deno python3"
  missing=""
  have_apk=1
  if ! command -v apk >/dev/null 2>&1; then
    have_apk=0
    warn "apk is unavailable; the Alpine dependencies could not be checked."
    DEPS=skip
  fi
  for package in $packages; do
    if [ "$have_apk" -eq 0 ] || ! apk info -e "$package" >/dev/null 2>&1; then
      missing="$missing $package"
    fi
  done
  if [ -n "$missing" ]; then
    say "Alpine runtime dependencies to install:$missing"
    if [ "$DEPS" = ask ]; then
      answer=""
      if [ -t 0 ]; then
        printf 'Install these dependencies with apk? [y/N] '
        read -r answer || answer=""
      elif ( : </dev/tty ) 2>/dev/null; then
        printf 'Install these dependencies with apk? [y/N] '
        read -r answer </dev/tty || answer=""
      else
        warn "No terminal available; use --install-deps to install dependencies automatically."
      fi
      case "$answer" in
        [yY]|[yY][eE][sS]) DEPS=install ;;
        *) DEPS=skip ;;
      esac
    fi
    if [ "$DEPS" = install ]; then
      if [ "$(id -u)" -eq 0 ]; then
        apk add --no-cache $missing || die "could not install Alpine runtime dependencies"
      elif command -v sudo >/dev/null 2>&1; then
        sudo apk add --no-cache $missing || die "could not install Alpine runtime dependencies"
      elif command -v doas >/dev/null 2>&1; then
        doas apk add --no-cache $missing || die "could not install Alpine runtime dependencies"
      else
        die "install the missing dependencies with apk add --no-cache:$missing"
      fi
    else
      warn "Wave may not work until its dependencies are installed."
      if [ "$have_apk" -eq 1 ]; then
        say "Install the Alpine packages manually with: apk add --no-cache$missing"
      else
        say "Install the equivalent packages using your distribution's package manager."
      fi
    fi
  fi

  mkdir -p "$PREFIX/bin" "$PREFIX/share/wave"
  PREFIX="$(cd "$PREFIX" && pwd -P)"
  BIN_STAGE="$(mktemp -d "$PREFIX/bin/.wave-update.XXXXXXXX")"
  cp "$TMP/wave" "$BIN_STAGE/wave"
  chmod +x "$BIN_STAGE/wave"
  if [ -f "$TMP/wave-bin" ]; then
    cp "$TMP/wave-bin" "$BIN_STAGE/wave-bin"
    chmod +x "$BIN_STAGE/wave-bin"
  fi
  if [ -f "$TMP/wave-webkit.py" ]; then
    cp "$TMP/wave-webkit.py" "$BIN_STAGE/wave-webkit.py"
  fi
  if [ -f "$BIN_STAGE/wave-bin" ]; then
    mv -f "$BIN_STAGE/wave-bin" "$PREFIX/bin/wave-bin"
  else
    rm -f "$PREFIX/bin/wave-bin"
  fi
  if [ -f "$BIN_STAGE/wave-webkit.py" ]; then
    mv -f "$BIN_STAGE/wave-webkit.py" "$PREFIX/bin/wave-webkit.py"
  else
    rm -f "$PREFIX/bin/wave-webkit.py"
  fi
  mv -f "$BIN_STAGE/wave" "$PREFIX/bin/wave"
  : > "$PREFIX/share/wave/musl-install"
  for icon in scalable:wave.svg 128x128:wave-128.png 256x256:wave-256.png; do
    size="${icon%%:*}"
    file="${icon#*:}"
    if [ -f "$TMP/$file" ]; then
      icon_dir="$DATA_HOME/icons/hicolor/$size/apps"
      mkdir -p "$icon_dir"
      cp "$TMP/$file" "$icon_dir/wave-bin.${file##*.}"
    fi
  done
  if [ -f "$TMP/wave-bin" ]; then
    rm -f "$DATA_HOME/applications/wave.desktop" "$HOME/.local/share/applications/wave.desktop"
    desktop_entry wave-bin wave-bin Wave-bin
  else
    rm -f "$DATA_HOME/applications/wave-bin.desktop"
    desktop_entry wave wave-bin Wave
  fi
  local_installed
elif [ -n "$deb" ] && command -v dpkg >/dev/null 2>&1; then
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
  warn_if_root
  # No root, no package manager: the AppImage goes somewhere on the PATH.
  mkdir -p "$PREFIX/bin"
  fetch "$appimage" "$PREFIX/bin/wave"
  chmod +x "$PREFIX/bin/wave"

  PREFIX="$(cd "$PREFIX" && pwd -P)"
  desktop_entry
  local_installed
else
  die "the v$VERSION release has no package for this architecture"
fi
