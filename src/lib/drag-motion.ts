export function createVelocitySampler(windowMs: number) {
  let samples: { at: number; value: number }[] = [];

  const sample = (value: number): void => {
    const at = performance.now();
    const last = samples[samples.length - 1];
    if (last?.at === at) {
      last.value = value;
    } else {
      samples.push({ at, value });
    }
    while (samples.length > 2 && samples[1].at <= at - windowMs) {
      samples.shift();
    }
  };

  return {
    reset(value: number): void {
      samples = [];
      sample(value);
    },
    sample,
    velocity(): number {
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (!first || !last || last.at <= first.at) {
        return 0;
      }
      const cutoff = last.at - windowMs;
      const second = samples[1];
      const start = Math.max(first.at, cutoff);
      // Interpolate at the window edge so sparse touch events retain their velocity.
      const value = start > first.at
        ? first.value + (second.value - first.value) * ((start - first.at) / (second.at - first.at))
        : first.value;
      return ((last.value - value) * 1000) / (last.at - start);
    },
  };
}

export function springStep(position: number, target: number, velocity: number, elapsed: number, rate: number) {
  const offset = position - target;
  const carry = velocity + rate * offset;
  const decay = Math.exp(-rate * elapsed);
  return {
    position: target + (offset + carry * elapsed) * decay,
    velocity: (velocity - rate * carry * elapsed) * decay,
  };
}
