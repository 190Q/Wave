export function nearbyArtwork(order: readonly string[], cursor: number, looping: boolean): string[] {
  if (cursor < 0 || cursor >= order.length) {
    return [];
  }

  const ids = new Set<string>();
  for (const offset of [0, -1, 1, -2, 2]) {
    const slot = cursor + offset;
    const index = looping ? ((slot % order.length) + order.length) % order.length : slot;
    const id = order[index];
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return [...ids];
}
