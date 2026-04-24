"use client";

import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase/client";

type Row = Record<string, unknown>;

export interface UseRealtimeOptions<T extends Row> {
  table: string;
  initialFetch?: {
    select?: string;
    order?: { column: string; ascending?: boolean };
    limit?: number;
    eq?: Record<string, unknown>;
  };
  onInsert?: (row: T) => void;
}

/**
 * Subscribe to a Supabase table via Realtime and keep an in-state list.
 * No-ops gracefully when the browser Supabase client is unavailable
 * (env not set) — returns an empty list + loading=false.
 */
export function useRealtime<T extends Row>(opts: UseRealtimeOptions<T>) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const sb = browserClient();
    if (!sb) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      let query = sb.from(opts.table).select(opts.initialFetch?.select ?? "*");
      if (opts.initialFetch?.eq) {
        for (const [col, val] of Object.entries(opts.initialFetch.eq)) {
          query = query.eq(col, val as never);
        }
      }
      if (opts.initialFetch?.order) {
        query = query.order(opts.initialFetch.order.column, {
          ascending: opts.initialFetch.order.ascending ?? false,
        });
      }
      if (opts.initialFetch?.limit) query = query.limit(opts.initialFetch.limit);
      const { data } = await query;
      if (!cancelled && data) setRows(data as T[]);
      setLoading(false);
    })();

    const channel = sb
      .channel(`rt:${opts.table}`)
      .on(
        // @ts-expect-error — Supabase types are loose for generic changes
        "postgres_changes",
        { event: "*", schema: "public", table: opts.table },
        (payload: { new?: T; eventType: string }) => {
          if (payload.eventType === "INSERT" && payload.new) {
            setRows((prev) => [payload.new as T, ...prev].slice(0, opts.initialFetch?.limit ?? 100));
            opts.onInsert?.(payload.new);
          } else if (payload.eventType === "UPDATE" && payload.new) {
            setRows((prev) => {
              const idx = prev.findIndex(
                (r) => (r as { id?: string }).id === (payload.new as { id?: string }).id,
              );
              if (idx === -1) return [payload.new as T, ...prev];
              const copy = prev.slice();
              copy[idx] = payload.new as T;
              return copy;
            });
          }
        },
      )
      .subscribe((status: string) => setConnected(status === "SUBSCRIBED"));

    return () => {
      cancelled = true;
      sb.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.table]);

  return { rows, loading, connected };
}
