#!/bin/sh
set -eu

export HOME=/home/wave
if [ -f /input/wave.tar.gz ]; then
  mkdir -p /tmp/wave-package
  for file in wave wave-bin wave-webkit.py VERSION; do
    if tar -tzf /input/wave.tar.gz | grep -Fxq "$file"; then
      tar -xzf /input/wave.tar.gz -C /tmp/wave-package "$file"
      [ -f "/tmp/wave-package/$file" ] && [ ! -L "/tmp/wave-package/$file" ] || {
        printf 'Invalid phone archive entry: %s\n' "$file" >&2
        exit 1
      }
    fi
  done
  WAVE_LOCAL_PACKAGE_DIR=/tmp/wave-package sh /opt/wave/install.sh --local
elif [ -n "${WAVE_LAB_VERSION:-}" ]; then
  sh /opt/wave/install.sh --version "$WAVE_LAB_VERSION"
else
  sh /opt/wave/install.sh
fi
chown -R wave:wave "$HOME"
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
exec su -s /bin/sh wave -c 'exec dbus-run-session -- sh /opt/wave/phone-lab-session.sh'
