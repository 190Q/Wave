import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

if (typeof WebSocket === "undefined") {
  throw new Error("The equaliser benchmark requires Node.js 22 or newer");
}

const root = fileURLToPath(new URL("..", import.meta.url));
const browser = process.env.WAVE_BENCHMARK_BROWSER ?? (process.platform === "win32"
  ? join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe")
  : process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "chromium");
const seconds = Number(process.env.WAVE_BENCHMARK_SECONDS ?? 10);
const pairs = Number(process.env.WAVE_BENCHMARK_PAIRS ?? 4);
if (!Number.isFinite(seconds) || seconds < 1 || !Number.isInteger(pairs) || pairs < 1) {
  throw new Error("WAVE_BENCHMARK_SECONDS must be at least 1 and WAVE_BENCHMARK_PAIRS a positive integer");
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const profile = await mkdtemp(join(tmpdir(), "wave-eq-benchmark-"));
const vite = await createViteServer({
  configFile: false,
  root,
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null, hmr: false },
});
const server = createHttpServer((request, response) => {
  if (request.url === "/benchmark") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Wave equaliser benchmark</title>");
  } else {
    vite.middlewares(request, response);
  }
});
let chrome;
let socket;

try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  chrome = spawn(browser, [
    "--headless=new",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-extensions",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });
  let launchError;
  chrome.on("error", (error) => { launchError = error; });

  let port;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (launchError) throw launchError;
    if (chrome.exitCode !== null) throw new Error(`Browser exited with code ${chrome.exitCode}`);
    try {
      port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!port) throw new Error("Browser debugging endpoint did not start");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message));
    else callbacks.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", {
    url: `http://127.0.0.1:${server.address().port}/benchmark`,
  });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate("location.pathname === '/benchmark' && document.readyState !== 'loading'")) break;
    if (attempt === 99) throw new Error("Benchmark page did not load");
    await sleep(100);
  }
  await evaluate(`(async () => {
    const { EqChain, DEFAULT_EQ_BANDS } = await import("/src/lib/eq.ts");
    const rate = 48000, frames = rate * 2;
    const bytes = new ArrayBuffer(44 + frames * 4);
    const view = new DataView(bytes);
    const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE");
    text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 2, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true);
    view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, frames * 4, true);
    for (let i = 0; i < frames; i++) {
      const value = Math.round(8000 * (Math.sin(i * 2 * Math.PI * 440 / rate) + Math.sin(i * 2 * Math.PI * 733 / rate)));
      view.setInt16(44 + i * 4, value, true);
      view.setInt16(46 + i * 4, value, true);
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    const updates = new WeakMap();
    const makeAudio = () => {
      const audio = new Audio(url);
      audio.crossOrigin = "anonymous";
      audio.loop = true;
      updates.set(audio, 0);
      audio.addEventListener("timeupdate", () => updates.set(audio, updates.get(audio) + 1));
      return audio;
    };
    const native = makeAudio(), routed = makeAudio();
    let eq;
    const settings = {
      eqEnabled: true, eqBands: DEFAULT_EQ_BANDS, eqLimiter: true,
      eqAutoPreamp: false, eqPreampDb: -3, eqOutputId: "",
    };
    window.chooseMode = async (mode) => {
      if (mode === "native") {
        routed.pause();
        await native.play();
      } else {
        native.pause();
        await routed.play();
        if (!eq) {
          eq = new EqChain({ latencyHint: "playback" });
          eq.attach(routed);
          eq.apply(settings);
          await eq.context.resume();
          eq.apply({ ...settings, eqEnabled: false });
        }
        eq.resume();
      }
    };
    window.measureState = (mode) => {
      const audio = mode === "native" ? native : routed;
      let peak = null;
      if (mode === "graph") {
        const samples = new Float32Array(eq.analyserNode.fftSize);
        eq.analyserNode.getFloatTimeDomainData(samples);
        peak = Math.max(...samples.map(Math.abs));
      }
      return {
        paused: audio.paused, time: audio.currentTime, context: eq?.context.state ?? null,
        updates: updates.get(audio), routed: eq?.sources.has(routed) ?? false, enabled: eq?.enabled ?? false, peak,
      };
    };
  })()`);

  const cpu = async () => {
    const { processInfo } = await send("SystemInfo.getProcessInfo");
    return new Map(processInfo.map(({ id, type, cpuTime }) => [id, { type, cpuTime }]));
  };
  const samples = { native: [], graph: [] };
  console.log(`${version.Browser}; ${seconds}s per sample; ${pairs} pairs; muted stereo 48 kHz WAV`);
  for (const mode of ["native", "graph"]) {
    await evaluate(`window.chooseMode(${JSON.stringify(mode)})`);
    await sleep(5000);
  }
  for (const mode of ["native", "graph"]) {
    await evaluate(`window.chooseMode(${JSON.stringify(mode)})`);
    await sleep(10000);
  }
  for (let pair = 0; pair < pairs; pair += 1) {
    for (const mode of pair % 2 === 0 ? ["native", "graph"] : ["graph", "native"]) {
      await evaluate(`window.chooseMode(${JSON.stringify(mode)})`);
      await sleep(1500);
      const beforeState = await evaluate(`window.measureState(${JSON.stringify(mode)})`);
      const before = await cpu();
      const started = performance.now();
      await sleep(seconds * 1000);
      const after = await cpu();
      const elapsed = (performance.now() - started) / 1000;
      const afterState = await evaluate(`window.measureState(${JSON.stringify(mode)})`);
      if (beforeState.paused || afterState.paused || beforeState.updates >= afterState.updates ||
          (mode === "native" && afterState.context !== "suspended") ||
          (mode === "graph" && (afterState.context !== "running" || !afterState.routed ||
            afterState.enabled || !(afterState.peak > 0)))) {
        throw new Error(`${mode} playback did not remain active: ${JSON.stringify({ beforeState, afterState })}`);
      }
      if (before.size !== after.size || [...before.keys()].some((id) => !after.has(id))) {
        throw new Error("Browser processes changed during a sample; repeat the benchmark");
      }
      const cpuByType = new Map();
      for (const [id, process] of after) {
        const previous = before.get(id);
        if (previous) {
          const delta = Math.max(0, process.cpuTime - previous.cpuTime);
          cpuByType.set(process.type, (cpuByType.get(process.type) ?? 0) + delta);
        }
      }
      const cpuSeconds = [...cpuByType.values()].reduce((total, value) => total + value, 0);
      const percent = 100 * cpuSeconds / elapsed;
      samples[mode].push(percent);
      const breakdown = [...cpuByType].map(([type, value]) => `${type} ${(100 * value / elapsed).toFixed(3)}%`);
      console.log(`${mode}: ${percent.toFixed(3)}% of one CPU core (${breakdown.join(", ")})`);
    }
  }
  const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const native = average(samples.native), graph = average(samples.graph);
  console.log(`Mean: native ${native.toFixed(3)}%, graph ${graph.toFixed(3)}%, difference ${(graph - native).toFixed(3)} percentage points of one core`);
  console.log(`Median: native ${median(samples.native).toFixed(3)}%, graph ${median(samples.graph).toFixed(3)}%, difference ${(median(samples.graph) - median(samples.native)).toFixed(3)} percentage points of one core`);
  console.log("Native playback keeps the unused context suspended; the graph was disabled after enabling 10 bands and the limiter.");
  console.log("These are muted headless-browser CPU measurements, not power or device-specific WebView measurements.");
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill();
    await Promise.race([new Promise((done) => chrome.once("exit", done)), sleep(3000)]);
  }
  await new Promise((done) => server.close(done));
  await vite.close();
  await rm(resolve(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
