"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatPercent } from "@/lib/formatters";
import type { Position } from "@/types/portfolio";

export function PositionCard({ position }: { position: Position }) {
  const isProfit = position.pnlDollars >= 0;
  const stopDistance = ((position.currentPrice - position.stopLoss) / position.currentPrice) * 100;

  return (
    <Card className="bg-card">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">{position.ticker}</span>
            <Badge
              variant="outline"
              className={
                position.status === "active"
                  ? "border-accent-green/30 text-accent-green"
                  : position.status === "watching"
                  ? "border-accent-yellow/30 text-accent-yellow"
                  : "border-accent-red/30 text-accent-red"
              }
            >
              {position.status}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            Conv: {position.convictionAtEntry}/100
          </span>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Price</p>
            <p className="font-mono font-medium tabular-nums">
              {formatCurrency(position.currentPrice)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Entry</p>
            <p className="font-mono tabular-nums">{formatCurrency(position.entryPrice)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">P&L</p>
            <p className={`font-mono font-medium tabular-nums ${isProfit ? "text-accent-green" : "text-accent-red"}`}>
              {isProfit ? "+" : ""}{formatCurrency(position.pnlDollars)}
            </p>
          </div>
        </div>

        <div className="mt-3">
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>Stop: {formatCurrency(position.stopLoss)}</span>
            <span>Target: {formatCurrency(position.target)}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                stopDistance > 5 ? "bg-accent-green" : stopDistance > 2 ? "bg-accent-yellow" : "bg-accent-red"
              }`}
              style={{
                width: `${Math.min(100, ((position.currentPrice - position.stopLoss) / (position.target - position.stopLoss)) * 100)}%`,
              }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
