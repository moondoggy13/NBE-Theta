"use client";

import { useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";

interface LogRow {
  id: number;
  ts: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  component: string;
  message: string;
  payload: Record<string, unknown> | null;
}

const LEVELS = ["all", "info", "warn", "error"] as const;

const COLOR: Record<LogRow["level"], string> = {
  trace: "text-slate-400",
  debug: "text-slate-500",
  info:  "text-slate-700",
  warn:  "text-amber-600",
  error: "text-rose-600",
  fatal: "text-rose-700 font-bold",
};

export function LogsFeed({ height = 280 }: { height?: number }) {
  const [filter, setFilter] = useState<(typeof LEVELS)[number]>("all");
  const { rows } = useRealtime<LogRow>({
    table: "system_logs",
    initialFetch: { order: { column: "ts" }, limit: 200 },
  });

  const visible = filter === "all"
    ? rows
    : rows.filter((r) =>
        filter === "warn" ? r.level === "warn" || r.level === "error" || r.level === "fatal" :
        filter === "error" ? r.level === "error" || r.level === "fatal" :
        r.level === filter,
      );

  return (
    <div className="flex flex-col gap-3" style={{ height }}>
      <div className="flex gap-2">
        {LEVELS.map((l) => (
          <button
            key={l}
            onClick={() => setFilter(l)}
            className={`px-2 py-1 rounded-full text-[10px] font-mono uppercase tracking-widest transition border ${
              filter === l
                ? "bg-fuchsia-500 text-white border-fuchsia-400"
                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {l}
          </button>
        ))}
        <span className="ml-auto text-[10px] font-mono text-slate-400">{visible.length} entries</span>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-50/50 border border-slate-200 rounded-xl p-2 font-mono text-[11px] leading-relaxed">
        {visible.length === 0 ? (
          <div className="text-slate-400 text-center py-6">No logs yet at this level.</div>
        ) : (
          visible.map((r) => (
            <div key={r.id} className="flex gap-3 py-0.5">
              <span className="text-slate-400 shrink-0 w-20">{new Date(r.ts).toLocaleTimeString()}</span>
              <span className={`shrink-0 w-12 uppercase ${COLOR[r.level]}`}>{r.level}</span>
              <span className="shrink-0 w-24 text-slate-500">{r.component}</span>
              <span className="text-slate-700 truncate">{r.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
