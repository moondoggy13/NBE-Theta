"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatPercent } from "@/lib/formatters";
import type { Position } from "@/types/portfolio";

export function UniverseTable({ positions }: { positions: Position[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Ticker</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Entry</TableHead>
          <TableHead className="text-right">Stop Loss</TableHead>
          <TableHead className="text-right">Target</TableHead>
          <TableHead className="text-right">Conviction</TableHead>
          <TableHead className="text-right">P&L</TableHead>
          <TableHead>Risk</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((pos) => {
          const isProfit = pos.pnlDollars >= 0;
          const stopDist = ((pos.currentPrice - pos.stopLoss) / pos.currentPrice) * 100;
          const progressPct = Math.min(
            100,
            ((pos.currentPrice - pos.stopLoss) / (pos.target - pos.stopLoss)) * 100
          );

          return (
            <TableRow key={pos.ticker}>
              <TableCell>
                <div>
                  <span className="font-semibold">{pos.ticker}</span>
                  <p className="text-xs text-muted-foreground">{pos.name}</p>
                </div>
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={
                    pos.status === "active"
                      ? "border-accent-green/30 text-accent-green"
                      : pos.status === "watching"
                      ? "border-accent-yellow/30 text-accent-yellow"
                      : "border-accent-red/30 text-accent-red"
                  }
                >
                  {pos.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatCurrency(pos.currentPrice)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                {formatCurrency(pos.entryPrice)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-accent-red">
                {formatCurrency(pos.stopLoss)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-accent-green">
                {formatCurrency(pos.target)}
              </TableCell>
              <TableCell className="text-right">
                <span className="font-mono tabular-nums font-medium">
                  {pos.convictionAtEntry}
                </span>
                <span className="text-muted-foreground text-xs">/100</span>
              </TableCell>
              <TableCell className={`text-right font-mono tabular-nums font-medium ${isProfit ? "text-accent-green" : "text-accent-red"}`}>
                {isProfit ? "+" : ""}{formatCurrency(pos.pnlDollars)}
                <span className="block text-xs">
                  {formatPercent(pos.pnlPercent)}
                </span>
              </TableCell>
              <TableCell>
                <div className="w-20">
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        stopDist > 5 ? "bg-accent-green" : stopDist > 2 ? "bg-accent-yellow" : "bg-accent-red"
                      }`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {stopDist.toFixed(1)}% to stop
                  </p>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
