#!/bin/sh
# Builds the aarch64 musl package, inside Alpine.
#
# The release workflow runs this through docker on an arm64 runner, so nothing
# is cross-compiled: the container is musl and the machine is aarch64. Alpine's
# own packages are the toolchain, and the phone config is the one used, so the
# download tools are neither fetched nor carried: they are glibc builds, and
# ffmpeg and Deno publish no musl build at all.
#
# The tarball is written by scripts/release.mjs, which the workflow then hands
# to `release.mjs upload-musl`.
set -eu

apk add --no-cache \
  build-base curl nodejs npm pkgconf \
  gtk+3.0-dev gstreamer-dev gst-plugins-base-dev \
  libayatana-appindicator-dev librsvg-dev \
  openssl-dev webkit2gtk-4.1-dev xdotool-dev

# rustup rather than Alpine's rust, which trails the version the app needs. On
# Alpine the host rustup installs is the musl one, which is the target here.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --no-modify-path
export PATH="$HOME/.cargo/bin:$PATH"

npm ci
node scripts/release.mjs musl
