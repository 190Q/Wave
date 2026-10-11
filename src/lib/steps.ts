let pending = 0;
let scheduled = false;
let action: ((direction: number) => void) | null = null;

const MAX_BACKLOG = 3;

/** Queues `direction` steps, positive being forwards. */
export function stepLater(direction: number, run: (direction: number) => void): void {
  pending = Math.max(-MAX_BACKLOG, Math.min(MAX_BACKLOG, pending + direction));
  action = run;
  schedule();
}

function schedule(): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  requestAnimationFrame(drain);
}

function drain(): void {
  scheduled = false;
  if (pending === 0 || !action) {
    return;
  }

  const direction = Math.sign(pending);
  pending -= direction;
  action(direction);

  if (pending !== 0) {
    schedule();
  }
}
