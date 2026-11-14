import type { AudioEngine } from "./audio";
import type { Player } from "./player";

const CHECK_MS = 1000;

const STEP_MS = 250;

const STALL_MS = 2500;

const COOLDOWN = 5;

export function mountAudioWatchdog(
  engine: AudioEngine,
  player: Player,
  report: (message: string) => void,
): void {
  let lastPosition = -1;
  let stillFor = 0;
  let cooldown = 0;

  const repair = (): void => {
    stillFor = 0;
    cooldown = COOLDOWN;

    const element = engine.element;
    if (element.paused) {
      report(`The sound was taken away by the system. ${describe(element)}`);
      player.pause();
      return;
    }

    report(`The sound stopped, so the song was asked for again. ${describe(element)}`);
    player.reloadCurrent();
  };

  window.setInterval(() => {
    const snapshot = player.snapshot();
    if (!snapshot.playing) {
      lastPosition = -1;
      stillFor = 0;
      return;
    }

    if (cooldown > 0) {
      cooldown -= 1;
      return;
    }

    const position = engine.positionMs;
    stillFor = lastPosition >= 0 && position - lastPosition < STEP_MS ? stillFor + CHECK_MS : 0;
    lastPosition = position;

    if (stillFor < STALL_MS || (document.hidden && engine.element.paused)) {
      return;
    }

    repair();
  }, CHECK_MS);
}

function describe(element: HTMLAudioElement): string {
  return (
    `Volume ${element.volume.toFixed(2)}, muted ${element.muted}, ` +
    `paused ${element.paused}, ready ${element.readyState}, ` +
    `network ${element.networkState}, error ${element.error?.code ?? 0}.`
  );
}
