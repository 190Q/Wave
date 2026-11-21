export class EditHistory<T> {
  private entries: T[];
  private index = 0;
  private group: string | null = null;

  constructor(initial: T, private readonly limit = 100) {
    this.entries = [structuredClone(initial)];
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  record(value: T, group: string | null = null): void {
    const next = structuredClone(value);
    if (JSON.stringify(next) === JSON.stringify(this.entries[this.index])) return;
    this.entries.splice(this.index + 1);
    if (group !== null && group === this.group && this.index > 0) {
      this.entries[this.index] = next;
    } else {
      this.entries.push(next);
      this.index += 1;
      if (this.entries.length > this.limit + 1) {
        this.entries.shift();
        this.index -= 1;
      }
    }
    this.group = group;
  }

  endGroup(): void {
    this.group = null;
  }

  undo(): T | null {
    this.endGroup();
    if (!this.canUndo) return null;
    this.index -= 1;
    return structuredClone(this.entries[this.index]);
  }

  redo(): T | null {
    this.endGroup();
    if (!this.canRedo) return null;
    this.index += 1;
    return structuredClone(this.entries[this.index]);
  }
}
