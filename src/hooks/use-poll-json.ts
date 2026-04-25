"use client";

import { useEffect, useState } from "react";

/**
 * Poll a JSON endpoint at a fixed interval. Useful for cheap, low-rate
 * refresh of API data (price, stats) that doesn't warrant a Realtime
 * subscription.
 */
export function usePollJson<T>(url: string, intervalMs = 2000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status}`);
        const j = (await res.json()) as T;
        if (!cancelled) {
          setData(j);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url, intervalMs]);

  return { data, error };
}
