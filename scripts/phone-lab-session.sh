#!/bin/sh
set -eu

export DISPLAY=:0
export GDK_BACKEND=x11
export GSK_RENDERER=cairo
export GTK_USE_PORTAL="${GTK_USE_PORTAL-1}"
export LIBGL_ALWAYS_SOFTWARE=1
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export XDG_RUNTIME_DIR="$HOME/runtime"
export XDG_CURRENT_DESKTOP=Phosh
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.config/xdg-desktop-portal"
chmod 700 "$XDG_RUNTIME_DIR"
printf '[preferred]\ndefault=phosh\n' > "$HOME/.config/xdg-desktop-portal/portals.conf"
dbus-update-activation-environment DISPLAY XDG_RUNTIME_DIR XDG_CURRENT_DESKTOP GSK_RENDERER

pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=wave_lab >/dev/null
pactl set-default-sink wave_lab
(
  while :; do
    ffmpeg -nostdin -hide_banner -loglevel warning -f pulse -i wave_lab.monitor \
      -c:a libmp3lame -b:a 96k -content_type audio/mpeg -f mp3 \
      -listen 1 http://0.0.0.0:6082/stream.mp3 || true
    sleep 1
  done
) &

Xvfb :0 -screen 0 360x720x24 -nolisten tcp &
sleep 2
fluxbox -no-toolbar -log "$HOME/.fluxbox.log" &
x11vnc -q -display :0 -localhost -nopw -forever -shared &
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 &
exec "$HOME/.local/bin/wave"
