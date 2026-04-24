import { describe, expect, it } from "vitest";
import { RingBuffer, makeIndicatorCache } from "../ring-buffer";

describe("RingBuffer", () => {
  it("rejects invalid capacity", () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
  });

  it("tracks size up to capacity", () => {
    const b = new RingBuffer<number>(3);
    expect(b.size).toBe(0);
    b.push(1);
    b.push(2);
    expect(b.size).toBe(2);
    b.push(3);
    b.push(4);
    expect(b.size).toBe(3);
  });

  it("retains newest items after overflow, chronologically ordered", () => {
    const b = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => b.push(n));
    expect(b.toArray()).toEqual([3, 4, 5]);
    expect(b.at(0)).toBe(3);
    expect(b.at(2)).toBe(5);
    expect(b.at(3)).toBeUndefined();
    expect(b.peek()).toBe(5);
  });

  it("last(n) returns the trailing slice", () => {
    const b = new RingBuffer<number>(5);
    [10, 20, 30, 40, 50].forEach((n) => b.push(n));
    expect(b.last(3)).toEqual([30, 40, 50]);
    expect(b.last()).toEqual([10, 20, 30, 40, 50]);
    expect(b.last(10)).toEqual([10, 20, 30, 40, 50]);
  });

  it("iterator yields in chronological order", () => {
    const b = new RingBuffer<number>(3);
    [1, 2, 3, 4].forEach((n) => b.push(n));
    expect([...b]).toEqual([2, 3, 4]);
  });

  it("clear resets to empty", () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.push(2);
    b.clear();
    expect(b.size).toBe(0);
    expect(b.peek()).toBeUndefined();
  });
});

describe("IndicatorCache", () => {
  it("memoizes by key", () => {
    const cache = makeIndicatorCache();
    let calls = 0;
    const v1 = cache.get("x", () => {
      calls++;
      return 42;
    });
    const v2 = cache.get("x", () => {
      calls++;
      return 99;
    });
    expect(v1).toBe(42);
    expect(v2).toBe(42);
    expect(calls).toBe(1);
  });

  it("clear allows recomputation", () => {
    const cache = makeIndicatorCache();
    cache.get("x", () => 1);
    cache.clear();
    expect(cache.get("x", () => 2)).toBe(2);
  });
});
