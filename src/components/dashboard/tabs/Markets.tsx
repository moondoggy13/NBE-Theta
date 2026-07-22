"use client";

import { useMemo, useState } from "react";
import { GlassPanel } from "../GlassPanel";
import { usePollJson } from "@/hooks/use-poll-json";

interface OutcomeRow {
  outcome_index: number;
  outcome_name: string;
  outcome_token_id: string;
}

interface MarketRow {
  venue: string;
  venue_market_id: string;
  condition_id: string;
  question: string;
  active: boolean;
  closed: boolean;
  resolved: boolean;
  opened_at: string;
  closes_at: string | null;
  resolution_source: string | null;
  outcomes: OutcomeRow[];
}

/**
 * Markets tab — renders the Polymarket registry populated by the
 * `theta-registry` ingestor. Reads via the server-side /api/markets
 * route (service-role); the browser never touches the DB directly.
 */
export function MarketsTab() {
  const [activeOnly, setActiveOnly] = useState(true);
  const url = useMemo(
    () => `/api/markets?limit=200${activeOnly ? "&active=true" : ""}`,
    [activeOnly],
  );
  const { data, error } = usePollJson<MarketRow[]>(url, 10_000);
  const markets = Array.isArray(data) ? data : [];

  return (
    <GlassPanel title="Market Registry" className="h-full bg-white/40" withCorners>
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs font-mono text-slate-500">
          {markets.length} market{markets.length === 1 ? "" : "s"}
          {error ? " · fetch error" : ""}
        </div>
        <button
          onClick={() => setActiveOnly((v) => !v)}
          className="px-3 py-1.5 rounded-full text-xs font-mono border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        >
          {activeOnly ? "Active only" : "All markets"}
        </button>
      </div>

      {markets.length === 0 ? (
        <div className="text-center text-xs font-mono text-slate-400 py-16">
          No markets yet. Run <code className="px-1 rounded bg-slate-100">theta-registry run</code>{" "}
          to populate the registry.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/60 bg-white/40">
          <table className="w-full text-left text-xs font-mono">
            <thead className="text-slate-500 border-b border-white/60">
              <tr>
                <th className="px-3 py-2 font-medium">Question</th>
                <th className="px-3 py-2 font-medium">Outcomes</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Closes</th>
                <th className="px-3 py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => (
                <tr
                  key={`${m.venue}:${m.venue_market_id}`}
                  className="border-b border-white/40 last:border-0 hover:bg-white/50"
                >
                  <td className="px-3 py-2 max-w-md truncate text-slate-800" title={m.question}>
                    {m.question}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {[...m.outcomes]
                      .sort((a, b) => a.outcome_index - b.outcome_index)
                      .map((o) => o.outcome_name)
                      .join(" / ") || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill market={m} />
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {m.closes_at ? new Date(m.closes_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-500 max-w-[10rem] truncate">
                    {m.resolution_source ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GlassPanel>
  );
}

function StatusPill({ market }: { market: MarketRow }) {
  const [label, cls] = market.resolved
    ? ["resolved", "bg-slate-200 text-slate-700"]
    : market.closed
      ? ["closed", "bg-amber-100 text-amber-700 border border-amber-300"]
      : market.active
        ? ["active", "bg-emerald-100 text-emerald-700 border border-emerald-300"]
        : ["inactive", "bg-slate-100 text-slate-500"];
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-widest ${cls}`}>
      {label}
    </span>
  );
}
