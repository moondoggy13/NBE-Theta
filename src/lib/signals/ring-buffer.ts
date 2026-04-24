import type { ReadonlyRingBuffer } from "./types";

export class RingBuffer<T> implements ReadonlyRingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private _size = 0;

  constructor(readonly capacity: number) {
    if (capacity <= 0 || !Number.isInteger(capacity)) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this._size;
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  /** 0 = oldest, size-1 = newest */
  at(i: number): T | undefined {
    if (i < 0 || i >= this._size) return undefined;
    const tail = (this.head - this._size + this.capacity) % this.capacity;
    return this.buf[(tail + i) % this.capacity];
  }

  /** Last item (newest), or undefined if empty. */
  peek(): T | undefined {
    if (this._size === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buf[idx];
  }

  /** Last n items (chronological: oldest → newest). Defaults to all. */
  last(n?: number): T[] {
    const count = n === undefined ? this._size : Math.min(n, this._size);
    const out: T[] = new Array(count);
    const start = this._size - count;
    for (let i = 0; i < count; i++) {
      out[i] = this.at(start + i)!;
    }
    return out;
  }

  toArray(): T[] {
    return this.last();
  }

  clear(): void {
    this.head = 0;
    this._size = 0;
    for (let i = 0; i < this.capacity; i++) this.buf[i] = undefined;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = 0; i < this._size; i++) yield this.at(i)!;
  }
}

export function makeIndicatorCache() {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, compute: () => T): T {
      if (store.has(key)) return store.get(key) as T;
      const v = compute();
      store.set(key, v);
      return v;
    },
    clear() {
      store.clear();
    },
  };
}
