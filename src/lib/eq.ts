import type { EqBand, EqBandKind, Settings } from "../types";

/** The bands a flat curve starts from, spread across the audible range. */
export const DEFAULT_EQ_BANDS: EqBand[] = [
  { id: "eq-31", kind: "peaking", freq: 31, gain: 0, q: 1, enabled: true },
  { id: "eq-62", kind: "peaking", freq: 62, gain: 0, q: 1, enabled: true },
  { id: "eq-125", kind: "peaking", freq: 125, gain: 0, q: 1, enabled: true },
  { id: "eq-250", kind: "peaking", freq: 250, gain: 0, q: 1, enabled: true },
  { id: "eq-500", kind: "peaking", freq: 500, gain: 0, q: 1, enabled: true },
  { id: "eq-1k", kind: "peaking", freq: 1000, gain: 0, q: 1, enabled: true },
  { id: "eq-2k", kind: "peaking", freq: 2000, gain: 0, q: 1, enabled: true },
  { id: "eq-4k", kind: "peaking", freq: 4000, gain: 0, q: 1, enabled: true },
  { id: "eq-8k", kind: "peaking", freq: 8000, gain: 0, q: 1, enabled: true },
  { id: "eq-16k", kind: "peaking", freq: 16000, gain: 0, q: 1, enabled: true },
];

/** The range the curve is drawn and levelled over. */
export const MIN_EQ_FREQ = 20;
export const MAX_EQ_FREQ = 20000;

/** The band gain limits, in decibels. */
export const MIN_EQ_GAIN = -24;
export const MAX_EQ_GAIN = 24;

const MIN_Q = 0.05;
const MAX_Q = 24;

/** How many points the response is sampled at, for the level and the drawing. */
const CURVE_POINTS = 512;

/** Kept below full scale, so a corner that rounds over cannot clip. */
const PREAMP_HEADROOM_DB = 0.5;

/** A magnitude this small counts as silence, so its logarithm stays finite. */
const MIN_MAGNITUDE = 0.0001;
const IDLE_DRAIN_MS = 300;

const WEB_KIND: Record<EqBandKind, BiquadFilterType> = {
  peaking: "peaking",
  lowShelf: "lowshelf",
  highShelf: "highshelf",
  lowPass: "lowpass",
  highPass: "highpass",
  bandPass: "bandpass",
  notch: "notch",
};

/** Why the equaliser cannot run, or `null` while it can. */
export type EqBlocked = "unsupported" | "cors" | null;

/** A response buffer, sized to the grid, as `getFrequencyResponse` wants it. */
type Curve = Float32Array<ArrayBuffer>;

const EMPTY: Curve = new Float32Array(0);

/** A context that can be told where to send its output, where the engine allows. */
type SinkableContext = AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };

/** The filter chain that sits behind the audio element. */
export class EqChain {
  private context: AudioContext | null = null;
  private input: GainNode | null = null;
  private output: GainNode | null = null;
  private preamp: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private analyser: AnalyserNode | null = null;

  /** One filter per band id, so dragging a band does not rebuild anything. */
  private readonly nodes = new Map<string, BiquadFilterNode>();
  private readonly kinds = new Map<string, EqBandKind>();

  private readonly elements = new Set<HTMLAudioElement>();
  private readonly sources = new Map<HTMLAudioElement, MediaElementAudioSourceNode>();
  private readonly statusListeners = new Set<() => void>();
  private readonly outputListeners = new Set<() => void>();
  private readonly routingListeners = new Set<() => void>();
  private lastLive = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;

  private settings: Settings | null = null;
  private blocked: EqBlocked = null;
  private preampDbValue = 0;
  private appliedOutput = "";
  private pendingOutput: string | null = null;
  private desiredOutput = "";

  /** The shape the chain is currently wired in, so it is only rebuilt when it moves. */
  private wiring = "";

  private freqs: Curve = EMPTY;
  private magnitudes: Curve = EMPTY;
  private phases: Curve = EMPTY;
  private response: Curve = EMPTY;
  private curveDirty = true;

  constructor(private readonly contextOptions?: AudioContextOptions) {}

  /** Why the equaliser is out of action, `null` while it is available. */
  get blockedReason(): EqBlocked {
    return this.blocked;
  }

  private routePending(): void {
    for (const element of this.elements) {
      this.route(element);
    }
    this.notifyStatus();
    this.pauseIfIdle();
  }

  /** True while the curve is being applied rather than passed through. */
  get live(): boolean {
    return this.enabled && this.context?.state === "running" &&
      this.elements.size > 0 && [...this.elements].every((element) => this.sources.has(element));
  }

  private get enabled(): boolean {
    return this.blocked === null && this.settings?.eqEnabled === true;
  }

  get canBypass(): boolean {
    const defaultOutput = (id: string): boolean => !id || id === "default";
    return !this.enabled && this.pendingOutput === null &&
      defaultOutput(this.appliedOutput) && defaultOutput(this.desiredOutput);
  }

  hasSource(element: HTMLAudioElement): boolean {
    return this.sources.has(element);
  }

  onRoutingChange(listener: () => void): () => void {
    this.routingListeners.add(listener);
    return () => this.routingListeners.delete(listener);
  }

  private notifyRouting(): void {
    for (const listener of this.routingListeners) {
      listener();
    }
  }

  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private notifyStatus(): void {
    const live = this.live;
    if (live === this.lastLive) {
      return;
    }
    this.lastLive = live;
    for (const listener of this.statusListeners) {
      listener();
    }
  }

  /** The preamp actually applied, in decibels, negative where it is trimming. */
  get preampDb(): number {
    return this.preampDbValue;
  }

  /** The spectrum tap, `null` until the chain has been started. */
  get analyserNode(): AnalyserNode | null {
    return this.analyser;
  }

  /** Whether this engine lets the output device be picked at all. */
  get canChooseOutput(): boolean {
    const constructor = audioContextConstructor();
    return constructor !== null && "setSinkId" in constructor.prototype;
  }

  get outputId(): string {
    return this.context && (this.enabled || this.sources.size > 0) ? this.appliedOutput : "";
  }

  onOutputChange(listener: () => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /** The frequencies the curve is sampled at, empty until the chain is started. */
  get frequencies(): Curve {
    return this.freqs;
  }

  /** Marks the chain unusable, so nothing new is routed through it. */
  block(reason: Exclude<EqBlocked, null>): void {
    if (this.blocked) {
      return;
    }
    this.blocked = reason;
    this.curveDirty = true;
    // Anything already routed keeps playing, because the chain goes flat
    // rather than being taken apart.
    this.rebuild();
    this.applyPreamp();
    this.notifyStatus();
    this.notifyRouting();
    this.pauseIfIdle();
  }

  /** Points the graph at an output, where the engine supports choosing one. */
  setOutput(deviceId: string): void {
    const context = this.context as SinkableContext | null;
    if (!context?.setSinkId) {
      return;
    }
    this.desiredOutput = deviceId;
    if (this.pendingOutput !== null || deviceId === this.appliedOutput) {
      this.notifyRouting();
      return;
    }
    this.pendingOutput = deviceId;
    this.notifyRouting();
    void context.setSinkId(deviceId).then(() => {
      this.appliedOutput = deviceId;
    }).catch(() => {}).finally(() => {
      this.pendingOutput = null;
      if (this.desiredOutput !== deviceId) {
        this.setOutput(this.desiredOutput);
      }
      for (const listener of this.outputListeners) {
        listener();
      }
      this.notifyRouting();
      if (this.canBypass) {
        this.pauseIfIdle();
      } else if (!this.enabled && this.appliedOutput && this.appliedOutput !== "default") {
        this.resume();
      }
    });
  }

  /** Wakes the context, which a browser may have started suspended. */
  resume(): void {
    const context = this.context;
    if (!context || (!this.enabled && this.canBypass && this.sources.size === 0)) {
      return;
    }
    if (context.state === "running") {
      this.routePending();
      return;
    }
    void context.resume().then(() => {
      if (this.context === context) this.routePending();
    }).catch(() => {});
  }

  private readonly pauseIfIdle = (): void => {
    const context = this.context;
    if (!context) {
      return;
    }
    if (this.canBypass && this.sources.size === 0) {
      this.close();
      return;
    }
    if ([...this.sources.keys()].some((element) => !element.paused)) {
      this.cancelSuspend();
      return;
    }
    if (context.state !== "running" || this.suspendTimer !== null) return;
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (this.context !== context || [...this.sources.keys()].some((element) => !element.paused)) return;
      void context.suspend().then(() => {
        if (this.context === context && [...this.sources.keys()].some((element) => !element.paused)) this.resume();
      }).catch(() => {});
    }, IDLE_DRAIN_MS);
  };

  private cancelSuspend(): void {
    if (this.suspendTimer === null) return;
    clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
  }

  private close(): void {
    const context = this.context;
    if (!context) return;
    this.cancelSuspend();
    context.onstatechange = null;
    this.context = null;
    this.input = null;
    this.output = null;
    this.preamp = null;
    this.limiter = null;
    this.analyser = null;
    this.nodes.clear();
    this.kinds.clear();
    this.wiring = "";
    this.freqs = EMPTY;
    this.magnitudes = EMPTY;
    this.phases = EMPTY;
    this.response = EMPTY;
    this.curveDirty = true;
    void context.close().catch(() => {});
  }

  private readonly resumeForPlayback = (): void => {
    this.resume();
  };

  /** Takes a new element into the graph, where the equaliser is wanted. */
  attach(element: HTMLAudioElement): void {
    this.elements.add(element);
    element.addEventListener?.("play", this.resumeForPlayback);
    element.addEventListener?.("pause", this.pauseIfIdle);
    element.addEventListener?.("ended", this.pauseIfIdle);
    this.route(element);
    this.notifyStatus();
    if (this.enabled && this.context?.state !== "running") {
      this.resume();
    }
  }

  /** Lets go of an element the engine has finished with. */
  detach(element: HTMLAudioElement): void {
    this.elements.delete(element);
    element.removeEventListener?.("play", this.resumeForPlayback);
    element.removeEventListener?.("pause", this.pauseIfIdle);
    element.removeEventListener?.("ended", this.pauseIfIdle);
    const source = this.sources.get(element);
    if (source) {
      source.disconnect();
      this.sources.delete(element);
    }
    this.notifyStatus();
    this.pauseIfIdle();
  }

  /** Applies the settings, rebuilding only what has changed shape. */
  apply(settings: Settings): void {
    this.settings = settings;
    this.curveDirty = true;

    if (!this.enabled) {
      if (!this.context && settings.eqOutputId && settings.eqOutputId !== "default" && this.canChooseOutput) {
        this.start();
      }
      if (this.context) {
        this.rebuild();
        this.applyPreamp();
        this.setOutput(settings.eqOutputId);
      }
      this.notifyStatus();
      this.notifyRouting();
      this.pauseIfIdle();
      return;
    }

    if (!this.start()) {
      return;
    }

    this.prune(settings.eqBands ?? []);
    this.rebuild();
    this.applyPreamp();
    this.setOutput(settings.eqOutputId);
    this.routePending();
    this.notifyStatus();
    if (this.context?.state !== "running") {
      this.resume();
    }
    this.notifyRouting();
  }

  /** The combined band response in decibels, one entry per frequency. */
  curve(): Curve {
    if (this.freqs.length === 0) {
      return EMPTY;
    }
    if (!this.curveDirty) {
      return this.response;
    }
    if (this.response.length !== this.freqs.length) {
      this.response = new Float32Array(this.freqs.length);
    }
    const db = this.response;
    db.fill(0);
    this.curveDirty = false;

    const settings = this.settings;
    if (!this.enabled || !settings) {
      return db;
    }

    for (const band of settings.eqBands ?? []) {
      if (!band.enabled) {
        continue;
      }
      const node = this.nodes.get(band.id);
      if (!node) {
        continue;
      }
      node.getFrequencyResponse(this.freqs, this.magnitudes, this.phases);
      for (let index = 0; index < db.length; index += 1) {
        db[index] += 20 * Math.log10(Math.max(this.magnitudes[index], MIN_MAGNITUDE));
      }
    }
    return db;
  }

  /** The automatic preamp figure alone, in decibels, as a negative number. */
  autoPreampDb(): number {
    if (!this.enabled) {
      return 0;
    }
    let peak = 0;
    for (const db of this.curve()) {
      if (db > peak) {
        peak = db;
      }
    }
    return peak > 0 ? -peak - PREAMP_HEADROOM_DB : 0;
  }

  /** Starts the context and the fixed part of the graph, once. */
  private start(): boolean {
    if (this.blocked) {
      return false;
    }
    if (this.context) {
      return true;
    }

    const constructor = audioContextConstructor();
    if (!constructor) {
      this.blocked = "unsupported";
      return false;
    }

    let context: AudioContext;
    try {
      context = new constructor(this.contextOptions);
    } catch {
      this.blocked = "unsupported";
      return false;
    }

    const input = context.createGain();
    const output = context.createGain();
    const preamp = context.createGain();
    const limiter = context.createDynamicsCompressor();

    // A brickwall safety net, not a true peak limiter: Web Audio cannot
    // oversample, so inter-sample peaks can still slip through.
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    limiter.connect(output);
    output.connect(context.destination);
    // The tap is taken after the bands, so the spectrum shows what is heard.
    output.connect(analyser);

    this.context = context;
    this.input = input;
    this.output = output;
    this.preamp = preamp;
    this.limiter = limiter;
    this.analyser = analyser;
    context.onstatechange = () => {
      if (context.state === "running") {
        this.routePending();
      }
      this.notifyStatus();
    };

    this.buildGrid(context);
    return true;
  }

  /** The frequencies every response is read at, spread evenly by ear. */
  private buildGrid(context: AudioContext): void {
    const ceiling = Math.min(MAX_EQ_FREQ, context.sampleRate * 0.49);
    const low = Math.log(MIN_EQ_FREQ);
    const high = Math.log(ceiling);
    const freqs: Curve = new Float32Array(CURVE_POINTS);
    for (let index = 0; index < CURVE_POINTS; index += 1) {
      freqs[index] = Math.exp(low + ((high - low) * index) / (CURVE_POINTS - 1));
    }
    this.freqs = freqs;
    this.magnitudes = new Float32Array(CURVE_POINTS);
    this.phases = new Float32Array(CURVE_POINTS);
    this.response = new Float32Array(CURVE_POINTS);
  }

  /** Builds a source node for an element, once, and feeds it into the chain. */
  private route(element: HTMLAudioElement): void {
    const retainedOutput = this.sources.size > 0 ||
      (this.appliedOutput !== "" && this.appliedOutput !== "default");
    if ((!this.enabled && (this.canBypass || !retainedOutput)) || !this.start()) {
      return;
    }
    if (this.sources.has(element)) {
      return;
    }
    const context = this.context;
    const input = this.input;
    if (!context || !input) {
      return;
    }
    if (context.state !== "running" || element.crossOrigin !== "anonymous") {
      return;
    }
    try {
      const source = context.createMediaElementSource(element);
      source.connect(input);
      this.sources.set(element, source);
      this.notifyStatus();
    } catch {
      // Already routed, or the element cannot be read; it plays on its own.
    }
  }

  /** Drops the filters whose band has gone. */
  private prune(bands: EqBand[]): void {
    const live = new Set(bands.map((band) => band.id));
    for (const [id, node] of this.nodes) {
      if (!live.has(id)) {
        node.disconnect();
        this.nodes.delete(id);
        this.kinds.delete(id);
      }
    }
  }

  /**
   * Wires the active bands between the input and the preamp, and pushes their
   * values.
   *
   * The values are set every time, because a band is dragged far more often
   * than the chain changes shape. The wiring is only torn down when the shape
   * actually moves, since a settings write happens while sound is playing and
   * taking the graph apart mid-note would be heard.
   */
  private rebuild(): void {
    const input = this.input;
    const preamp = this.preamp;
    const output = this.output;
    const limiter = this.limiter;
    const settings = this.settings;
    if (!input || !preamp || !output || !limiter) {
      return;
    }

    const bands = this.enabled ? (settings?.eqBands ?? []).filter((band) => band.enabled) : [];
    const limiterOn = this.enabled && settings?.eqLimiter !== false;
    const signature = `${bands.map((band) => `${band.id}:${band.kind}`).join(",")}|${limiterOn}`;
    const moved = signature !== this.wiring;

    if (moved) {
      input.disconnect();
      preamp.disconnect();
      for (const node of this.nodes.values()) {
        node.disconnect();
      }
    }

    let tail: AudioNode = input;
    for (const band of bands) {
      const node = this.nodeFor(band);
      if (!node) {
        continue;
      }
      if (moved) {
        tail.connect(node);
      }
      tail = node;
    }

    if (moved) {
      tail.connect(preamp);
      preamp.connect(limiterOn ? limiter : output);
      this.wiring = signature;
    }
  }

  /** The filter for a band, made or reshaped as its kind changes. */
  private nodeFor(band: EqBand): BiquadFilterNode | null {
    const context = this.context;
    if (!context) {
      return null;
    }

    let node = this.nodes.get(band.id);
    if (!node || this.kinds.get(band.id) !== band.kind) {
      node?.disconnect();
      node = context.createBiquadFilter();
      this.nodes.set(band.id, node);
      this.kinds.set(band.id, band.kind);
    }

    node.type = WEB_KIND[band.kind] ?? "peaking";
    node.frequency.value = clamp(band.freq, MIN_EQ_FREQ, maxFrequency(context));
    node.Q.value = clamp(band.q, MIN_Q, MAX_Q);
    node.gain.value = clamp(band.gain, MIN_EQ_GAIN, MAX_EQ_GAIN);
    return node;
  }

  /**
   * Levels the curve. The loudest point of the response is brought to full
   * scale, so a boost cannot push a track that was already levelled over it.
   */
  private applyPreamp(): void {
    const preamp = this.preamp;
    if (!preamp) {
      return;
    }

    if (!this.enabled) {
      this.preampDbValue = 0;
      preamp.gain.value = 1;
      return;
    }

    const settings = this.settings;
    const auto = settings?.eqAutoPreamp === false ? 0 : this.autoPreampDb();
    const total = auto + (settings?.eqPreampDb ?? 0);
    this.preampDbValue = total;
    preamp.gain.value = 10 ** (total / 20);
  }
}

/** The audible ceiling this context can carry. */
function maxFrequency(context: AudioContext): number {
  return Math.min(MAX_EQ_FREQ, context.sampleRate * 0.49);
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) {
    return low;
  }
  return Math.min(Math.max(value, low), high);
}

/** WebKit still ships the constructor under the old prefixed name. */
function audioContextConstructor(): typeof AudioContext | null {
  if (typeof AudioContext !== "undefined") {
    return AudioContext;
  }
  const legacy = (window as unknown as { webkitAudioContext?: typeof AudioContext })
    .webkitAudioContext;
  return legacy ?? null;
}
