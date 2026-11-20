#!/bin/sh
set -eu

apk add --no-cache webkit2gtk-4.1 xvfb-run dbus python3
if ! id wave >/dev/null 2>&1; then
  adduser -D wave
fi
su -s /bin/sh wave -c '
  if [ "${WAVE_TEST_WEBKIT_SANDBOX:-0}" = 1 ]; then
    export WEBKIT_FORCE_SANDBOX=1
  else
    export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
  fi
  export LIBGL_ALWAYS_SOFTWARE=1
  export GDK_BACKEND=x11
  xvfb-run -a dbus-run-session -- sh /wave/tests/webkit-real.test.sh
'
