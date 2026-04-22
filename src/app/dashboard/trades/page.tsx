"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TradeLogTable } from "@/components/dashboard/trade-log-table";
import { usePolling } from "@/hooks/use-polling";
import { mockTrades } from "@/data/mock-portfolio";
import { formatCurrency } from "@/lib/formatters";
import type { Trade } from "@/types/portfolio";

export default function TradesPage() {
  const { data: tradesData } = usePolling<Trade[]>(
    async () => {
      const res = await fetch("/api/trades");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    60_000
  );

  const trades = tradesData ?? mockTrades;
  const wins = trades.filter((t) => t.pnlDollars >= 0);
  const losses = trades.filter((t) => t.pnlDollars < 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlDollars, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlDollars, 0) / losses.length : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnlDollars, 0);
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin * wins.length) / Math.abs(avgLoss * losses.length) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Trade Log</h1>
        <p className="text-sm text-muted-foreground">
          Historical trade performance and analytics
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Total Trades</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{trades.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Win Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-accent-green">{winRate.toFixed(0)}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Avg Win</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-accent-green">{formatCurrency(avgWin)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Avg Loss</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-accent-red">{formatCurrency(avgLoss)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Profit Factor</CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${profitFactor >= 1 ? "text-accent-green" : "text-accent-red"}`}>
              {profitFactor.toFixed(2)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex justify-between items-center">
            <CardTitle className="text-sm text-muted-foreground">Trade History</CardTitle>
            <span className={`text-sm font-bold font-mono ${totalPnl >= 0 ? "text-accent-green" : "text-accent-red"}`}>
              Net: {totalPnl >= 0 ? "+" : ""}{formatCurrency(totalPnl)}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <TradeLogTable trades={trades} />
        </CardContent>
      </Card>
    </div>
  );
}
