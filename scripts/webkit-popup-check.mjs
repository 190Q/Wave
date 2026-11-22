#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.WAVE_WEBKIT_TEST_IMAGE ?? "alpine:3.22";
const platform = process.env.WAVE_WEBKIT_TEST_PLATFORM ?? "linux/arm64";
const name = `wave-popup-check-${randomUUID().slice(0, 8)}`;
const server = await createServer({
  configFile: false,
  root,
  logLevel: "error",
  server: {
    host: "0.0.0.0",
    port: 0,
    allowedHosts: ["host.docker.internal"],
    watch: null,
    hmr: false,
  },
});

try {
  await server.listen();
  const port = server.httpServer.address().port;
  const url = `http://host.docker.internal:${port}/dev/phone/app.html?device=linuxPhone`;
  const shell = `
    set -e
    printf 'Installing Alpine WebKitGTK test dependencies\\n'
    apk add --quiet --no-cache webkit2gtk-4.1 xvfb dbus python3 py3-gobject3 xdotool \\
      font-dejavu gst-plugins-base gst-plugins-good
    id wave >/dev/null 2>&1 || adduser -D wave
    export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 LIBGL_ALWAYS_SOFTWARE=1
    export WEBKIT_DISABLE_COMPOSITING_MODE=1 JSC_useJIT=0 JSC_useConcurrentJIT=0
    export GDK_BACKEND=x11 GSETTINGS_BACKEND=memory DISPLAY=:88
    Xvfb :88 -screen 0 360x720x24 -nolisten tcp -ac &
    xvfb=$!
    trap 'kill "$xvfb" 2>/dev/null || true' EXIT
    sleep 3
    su -s /bin/sh wave -c 'timeout 180 dbus-run-session -- python3 -u /wave/tests/webkit-popup.test.py'
  `;
  const child = spawn("docker", [
    "run", "--rm", "--name", name, "--platform", platform, "--shm-size", "512m",
    "--add-host", "host.docker.internal:host-gateway",
    "--mount", `type=bind,source=${root},target=/wave,readonly`,
    "-e", `WAVE_TEST_URL=${url}`,
    "--entrypoint", "sh", image, "-c", shell,
  ], { cwd: root, stdio: "inherit" });
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    spawn("docker", ["stop", "--timeout", "2", name], { stdio: "ignore" });
    child.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const status = await new Promise((done, fail) => {
      child.on("error", fail);
      child.on("close", done);
    });
    process.exitCode = interrupted ? 130 : (status ?? 1);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
} finally {
  await server.close();
}
