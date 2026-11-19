(() => {
  const svg = document.querySelector(".startup-flow");
  if (!svg) return;

  const width = 512;
  const points = [
    { x: 0, top: 236, bottom: 244 },
    { x: 36, top: 221, bottom: 230 },
    { x: 165, top: 322, bottom: 415 },
    { x: 322, top: 97, bottom: 183 },
    { x: 492, top: 372, bottom: 376 },
    { x: 512, top: 372, bottom: 376 },
  ];

  const lines = Array.from({ length: 5 }, (_, line) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const samples = [];
    let segment = 0;
    for (let x = 0; x <= width; x += 4) {
      while (segment < points.length - 2 && x > points[segment + 1].x) {
        segment += 1;
      }
      const p = points[segment];
      const q = points[segment + 1];
      const weight = (1 - Math.cos(Math.PI * (x - p.x) / (q.x - p.x))) / 2;
      const start = p.top + (p.bottom - p.top) * line / 4;
      const end = q.top + (q.bottom - q.top) * line / 4;
      samples.push({
        x,
        y: start + (end - start) * weight,
        amplitude: 16 * Math.sin(Math.PI * x / width),
      });
    }
    svg.appendChild(path);
    return { path, samples };
  });

  const paint = (time) => {
    lines.forEach(({ path, samples }, index) => {
      const d = samples
        .map(({ x, y, amplitude }) => {
          const ripple = time === null
            ? 0
            : amplitude * Math.sin(2 * Math.PI * time / 2.2 - x * 0.014 - index * 0.55);
          return `${x === 0 ? "M" : "L"}${x} ${(y + ripple).toFixed(1)}`;
        })
        .join(" ");
      path.setAttribute("d", d);
    });
  };

  let frame = null;
  let startedAt = 0;
  let stopped = false;
  const tick = (now) => {
    paint((now - startedAt) / 1000);
    frame = requestAnimationFrame(tick);
  };
  const syncMotion = (reduced) => {
    if (stopped) return;
    if (reduced) {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      paint(null);
    } else if (frame === null) {
      startedAt = performance.now();
      paint(0);
      frame = requestAnimationFrame(tick);
    }
  };

  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  const followSystem = () => syncMotion(query.matches);
  query.addEventListener("change", followSystem);
  window.__WAVE_STARTUP__ = {
    setReducedMotion(reduced) {
      query.removeEventListener("change", followSystem);
      syncMotion(reduced);
    },
    stop() {
      stopped = true;
      query.removeEventListener("change", followSystem);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    },
  };
  followSystem();
})();
