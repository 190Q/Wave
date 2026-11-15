import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, loadConfigFromFile } from "vite";

test("Android hot reload uses the forwarded development server port", async () => {
  const previousHost = process.env.TAURI_DEV_HOST;
  process.env.TAURI_DEV_HOST = "127.0.0.1";
  let config;
  try {
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "development" },
      fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    );
    config = loaded.config;
  } finally {
    if (previousHost === undefined) delete process.env.TAURI_DEV_HOST;
    else process.env.TAURI_DEV_HOST = previousHost;
  }

  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.server.hmr.host, "127.0.0.1");
  assert.equal(config.server.hmr.clientPort, config.server.port);
  assert.equal(config.server.hmr.port, undefined);

  const vite = await createServer({
    ...config,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    server: { ...config.server, port: 0, strictPort: false, watch: null },
  });
  try {
    await vite.listen();
    const port = vite.httpServer.address().port;
    const client = await vite.transformRequest("/@vite/client");
    assert.match(client.code, /const hmrPort = 1420;/);
    assert.match(client.code, /"127\.0\.0\.1" \|\| importMetaUrl\.hostname/);

    const socket = await new Promise((resolve, reject) => {
      const upgrade = request({
        hostname: "127.0.0.1",
        port,
        path: `/?token=${vite.config.webSocketToken}`,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          Origin: "http://tauri.localhost",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Protocol": "vite-hmr",
          "Sec-WebSocket-Version": "13",
        },
      });
      upgrade.once("upgrade", (response, connection) => {
        if (response.statusCode !== 101) reject(new Error(`Unexpected status ${response.statusCode}`));
        else resolve(connection);
      });
      upgrade.once("response", (response) => reject(new Error(`Unexpected status ${response.statusCode}`)));
      upgrade.once("error", reject);
      upgrade.setTimeout(5000, () => upgrade.destroy(new Error("WebSocket upgrade timed out")));
      upgrade.end();
    });
    socket.destroy();
  } finally {
    await vite.close();
  }
});
