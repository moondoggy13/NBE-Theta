"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NumberTicker } from "@/components/magicui/number-ticker";
import { formatCurrency, formatPercent } from "@/lib/formatters";
import type { PortfolioSummary } from "@/types/portfolio";

export function PortfolioSummaryCard({ data }: { data: PortfolioSummary }) {
  return (
    <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-card to-primary/5">
      <div className="absolute inset-0 bg-gradient-to-r from-primary/5 via-transparent to-signal-catalyst/5" />
      <CardHeader className="relative pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Portfolio Value
        </CardTitle>
      </CardHeader>
      <CardContent className="relative">
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold text-primary">$</span>
          <NumberTicker
            value={data.totalValue}
            decimalPlaces={2}
            className="text-3xl font-bold text-primary"
          />
        </div>
        <div className="mt-2 flex items-center gap-3 text-sm">
          <span className={data.dayPnlDollars >= 0 ? "text-accent-green" : "text-accent-red"}>
            {data.dayPnlDollars >= 0 ? "+" : ""}
            {formatCurrency(data.dayPnlDollars)} ({formatPercent(data.dayPnlPercent)})
          </span>
          <span className="text-muted-foreground">today</span>
        </div>
      </CardContent>
    </Card>
  );
}
