import { reduceMotionActive, subscribeMotion } from "../lib/motion";

declare global {
  interface Window {
    __WAVE_STARTUP__?: {
      setReducedMotion(reduced: boolean): void;
      stop(): void;
    };
  }
}

export function mountStartup(): () => void {
  const startup = window.__WAVE_STARTUP__;
  if (!startup) return () => {};

  const syncMotion = (): void => startup.setReducedMotion(reduceMotionActive());
  const unsubscribe = subscribeMotion(syncMotion);
  syncMotion();
  return () => {
    unsubscribe();
    startup.stop();
  };
}
