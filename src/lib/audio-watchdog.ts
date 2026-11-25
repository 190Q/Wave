import type { AudioEngine } from "./audio";
import { uiActive } from "./activity";
import type { Player } from "./player";

const CHECK_MS = 1000;

const MIN_SAMPLE_GAP_MS = 500;
const MAX_SAMPLE_GAP_MS = 2500;

const STALL_MS = 5000;
const HIDDEN_STALL_MS = 15000;

const COOLDOWN_MS = 5000;

export function mountAudioWatchdog(
  engine: AudioEngine,
  player: Player,
  report: (message: string) => void,
): void {
  let lastPosition: number | null = null;
  let lastSampleAt = 0;
  let lastElement: HTMLAudioElement | null = null;
  let lastTrack: string | null = null;
  let lastHidden = false;
  let lastSeeking = false;
  let stillFor = 0;
  let cooldownUntil = 0;
  let timer: number | null = null;

  const reset = (): void => {
    lastPosition = null;
    stillFor = 0;
  };

  const repair = (now: number): void => {
    reset();
    cooldownUntil = now + COOLDOWN_MS;

    const element = engine.element;
    if (element.paused) {
      report(`The sound was taken away by the system. ${describe(element)}`);
      player.pauseForInterruption();
      return;
    }

    report(`The sound stopped, so the song was asked for again. ${describe(element)}`);
    player.reloadCurrent();
  };

  const check = (): void => {
    const snapshot = player.snapshot();
    const element = engine.element;
    const now = performance.now();
    const hidden = !uiActive();
    if (hidden && snapshot.playing) {
      player.sampleListening();
    }
    if (!snapshot.playing || !snapshot.currentId || element.ended) {
      reset();
      return;
    }

    if (now < cooldownUntil) {
      reset();
      return;
    }

    const position = engine.positionMs;
    const gap = now - lastSampleAt;
    if (
      lastPosition === null || element !== lastElement || snapshot.currentId !== lastTrack ||
      hidden !== lastHidden || element.seeking !== lastSeeking || gap < 0 || gap > MAX_SAMPLE_GAP_MS
    ) {
      lastPosition = position;
      lastSampleAt = now;
      lastElement = element;
      lastTrack = snapshot.currentId;
      lastHidden = hidden;
      lastSeeking = element.seeking;
      stillFor = 0;
      return;
    }
    if (gap < MIN_SAMPLE_GAP_MS) {
      return;
    }

    stillFor = position === lastPosition ? stillFor + gap : 0;
    lastPosition = position;
    lastSampleAt = now;

    if (stillFor < (hidden ? HIDDEN_STALL_MS : STALL_MS)) {
      return;
    }

    repair(now);
  };

  const sync = (): void => {
    const snapshot = player.snapshot();
    if (snapshot.playing && snapshot.currentId) {
      if (timer === null) {
        timer = window.setInterval(check, CHECK_MS);
      }
    } else {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      reset();
    }
  };

  player.onChange(sync);
  sync();
}

function describe(element: HTMLAudioElement): string {
  return (
    `Volume ${element.volume.toFixed(2)}, muted ${element.muted}, ` +
    `paused ${element.paused}, ready ${element.readyState}, ` +
    `network ${element.networkState}, error ${element.error?.code ?? 0}.`
  );
}
