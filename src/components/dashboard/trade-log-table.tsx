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
import type { Trade } from "@/types/portfolio";

export function TradeLogTable({ trades }: { trades: Trade[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Ticker</TableHead>
          <TableHead>Side</TableHead>
          <TableHead className="text-right">Entry</TableHead>
          <TableHead className="text-right">Exit</TableHead>
          <TableHead className="text-right">Shares</TableHead>
          <TableHead className="text-right">P&L</TableHead>
          <TableHead className="text-right">Hold Time</TableHead>
          <TableHead className="text-right">Conviction</TableHead>
          <TableHead>Exit Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((trade) => {
          const isWin = trade.pnlDollars >= 0;
          const holdHours = Math.floor(trade.holdTimeMinutes / 60);
          const holdMins = trade.holdTimeMinutes % 60;

          return (
            <TableRow key={trade.id}>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(trade.enteredAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </TableCell>
              <TableCell className="font-semibold">{trade.ticker}</TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={
                    trade.side === "long"
                      ? "border-accent-green/30 text-accent-green"
                      : "border-accent-red/30 text-accent-red"
                  }
                >
                  {trade.side}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                {formatCurrency(trade.entryPrice)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                {formatCurrency(trade.exitPrice)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {trade.shares}
              </TableCell>
              <TableCell
                className={`text-right font-mono tabular-nums font-medium ${
                  isWin ? "text-accent-green" : "text-accent-red"
                }`}
              >
                {isWin ? "+" : ""}
                {formatCurrency(trade.pnlDollars)}
                <span className="block text-xs">{formatPercent(trade.pnlPercent)}</span>
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {holdHours}h {holdMins}m
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {trade.convictionAtEntry}
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={
                    trade.exitReason === "target"
                      ? "text-accent-green border-accent-green/30"
                      : trade.exitReason === "stop_loss"
                      ? "text-accent-red border-accent-red/30"
                      : "text-muted-foreground"
                  }
                >
                  {trade.exitReason.replace("_", " ")}
                </Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
