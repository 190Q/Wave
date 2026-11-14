import { hashText } from "./hash";

/** Every cover is drawn square at this size. */
const SIZE = 320;

const cache = new Map<string, Promise<ArrayBuffer>>();

/** A drawn cover for one artwork path, so every song has a picture of its own. */
export function artworkJpeg(path: string): Promise<ArrayBuffer> {
  return draw(`one:${path}`, (ctx) => paintOne(ctx, path));
}

/** A drawn cover for a collection, from up to four of its songs' artwork. */
export function coverJpeg(paths: string[]): Promise<ArrayBuffer> {
  const tiles = paths.filter(Boolean).slice(0, 4);
  return draw(`many:${tiles.join("|")}`, (ctx) => paintMany(ctx, tiles));
}

function draw(key: string, paint: (ctx: CanvasRenderingContext2D) => void): Promise<ArrayBuffer> {
  const kept = cache.get(key);
  if (kept !== undefined) {
    return kept;
  }
  const started = render(paint);
  cache.set(key, started);
  return started;
}

async function render(paint: (ctx: CanvasRenderingContext2D) => void): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("The simulator could not draw a cover.");
  }
  paint(ctx);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  if (!blob) {
    throw new Error("The simulator could not encode a cover.");
  }
  return blob.arrayBuffer();
}

/** A gradient, then a few blobs, all read off the path so it never moves. */
function paintOne(ctx: CanvasRenderingContext2D, path: string): void {
  const seed = hashText(path);
  const hue = seed % 360;

  const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  gradient.addColorStop(0, `hsl(${hue} 52% 44%)`);
  gradient.addColorStop(1, `hsl(${(hue + 44) % 360} 42% 16%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SIZE, SIZE);

  for (let index = 0; index < 4; index += 1) {
    const step = (seed >> (index * 5)) % 100;
    ctx.fillStyle = `hsl(${(hue + 70 + index * 32) % 360} 62% ${38 + (step % 28)}% / 0.55)`;
    ctx.beginPath();
    ctx.arc(
      ((step * 13) % 100) / 100 * SIZE,
      ((step * 7) % 100) / 100 * SIZE,
      26 + (step % 58),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

function paintMany(ctx: CanvasRenderingContext2D, paths: string[]): void {
  if (paths.length <= 1) {
    paintOne(ctx, paths[0] ?? "wave");
    return;
  }

  const half = SIZE / 2;
  const tiles: { x: number; y: number; size: number }[] =
    paths.length === 2
      ? [{ x: 0, y: 0, size: half }, { x: half, y: 0, size: half }]
      : paths.length === 3
        ? [
            { x: 0, y: 0, size: half },
            { x: half, y: 0, size: half },
            { x: 0, y: half, size: SIZE },
          ]
        : [
            { x: 0, y: 0, size: half },
            { x: half, y: 0, size: half },
            { x: 0, y: half, size: half },
            { x: half, y: half, size: half },
          ];

  tiles.forEach((tile, at) => {
    ctx.save();
    ctx.translate(tile.x, tile.y);
    ctx.beginPath();
    ctx.rect(0, 0, tile.size, tile.size);
    ctx.clip();
    ctx.scale(tile.size / SIZE, tile.size / SIZE);
    paintOne(ctx, paths[at] ?? "wave");
    ctx.restore();
  });
}
