"use client";

import { useEffect, useState } from "react";

/**
 * Returns the current wall-clock time as React state, ticking at the
 * specified interval. Use in place of inline `Date.now()` calls during
 * render — Next.js 16's react-hooks/purity rule (correctly) flags
 * direct `Date.now()` reads inside render bodies because they make the
 * component non-deterministic.
 */
export function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
