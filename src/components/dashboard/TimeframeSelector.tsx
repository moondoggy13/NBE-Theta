"use client";

export const TIMEFRAMES = ["15m", "1h", "6h", "24h", "7d", "All"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "15m": 15 * 60_000,
  "1h":  60 * 60_000,
  "6h":  6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d":  7 * 24 * 60 * 60_000,
  "All": Number.POSITIVE_INFINITY,
};

export function TimeframeSelector({
  value,
  onChange,
  className = "",
}: {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
  className?: string;
}) {
  return (
    <div className={`inline-flex rounded-full border border-slate-200 bg-white/60 p-0.5 ${className}`}>
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          onClick={() => onChange(tf)}
          className={`px-2.5 py-1 rounded-full text-[10px] font-mono uppercase tracking-widest transition ${
            value === tf
              ? "bg-fuchsia-500 text-white shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}
