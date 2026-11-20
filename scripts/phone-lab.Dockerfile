FROM alpine:3.22

RUN apk add --no-cache curl xvfb dbus x11vnc novnc fluxbox font-dejavu pulseaudio pulseaudio-utils
RUN adduser -D wave
COPY install.sh /opt/wave/install.sh
COPY scripts/phone-lab-entry.sh scripts/phone-lab-session.sh /opt/wave/
ENTRYPOINT ["sh", "/opt/wave/phone-lab-entry.sh"]
