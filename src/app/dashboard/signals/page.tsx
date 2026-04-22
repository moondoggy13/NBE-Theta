"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ConvictionScoreRing } from "@/components/dashboard/conviction-score-ring";
import { SignalLayerBar } from "@/components/dashboard/signal-layer-bar";
import { usePolling } from "@/hooks/use-polling";
import { mockSignals } from "@/data/mock-signals";
import { STRATEGY, SIGNAL_LAYERS } from "@/lib/constants";
import { formatCompactCurrency, formatVolume } from "@/lib/formatters";
import type { StockSignal } from "@/types/signals";

export default function SignalsPage() {
  const { data: signals } = usePolling<StockSignal[]>(
    async () => {
      const res = await fetch("/api/signals");
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    30_000
  );

  const allSignals = signals ?? mockSignals;
  const sorted = [...allSignals].sort((a, b) => b.convictionScore - a.convictionScore);
  const [selected, setSelected] = useState<StockSignal>(sorted[0]);

  // Update selected if data refreshed and the selected ticker still exists
  const currentSelected = sorted.find((s) => s.ticker === selected.ticker) ?? sorted[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Signal Engine</h1>
        <p className="text-sm text-muted-foreground">
          5-layer conviction scoring across candidate stocks
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Stock List */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Candidates ({sorted.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[calc(100vh-280px)]">
              <div className="space-y-1 px-2 pb-2">
                {sorted.map((stock) => (
                  <button
                    key={stock.ticker}
                    onClick={() => setSelected(stock)}
                    className={`w-full flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${
                      currentSelected.ticker === stock.ticker
                        ? "bg-primary/10 border border-primary/20"
                        : "hover:bg-muted/50 border border-transparent"
                    }`}
                  >
                    <ConvictionScoreRing score={stock.convictionScore} size="small" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{stock.ticker}</span>
                        {stock.inUniverse && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-accent-green/30 text-accent-green">
                            IN UNIVERSE
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{stock.name}</p>
                    </div>
                    <span className="font-mono text-sm tabular-nums font-medium">
                      {stock.convictionScore}
                    </span>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Signal Detail */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-start gap-6">
                <ConvictionScoreRing score={currentSelected.convictionScore} />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold">{currentSelected.ticker}</h2>
                    <span className="text-muted-foreground">{currentSelected.name}</span>
                    {currentSelected.inUniverse ? (
                      <Badge className="bg-accent-green/20 text-accent-green border-accent-green/30">
                        Active Universe
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Below Threshold
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{currentSelected.catalyst}</p>
                  <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
                    <span>Sector: {currentSelected.sector}</span>
                    <span>Mkt Cap: {formatCompactCurrency(currentSelected.marketCap)}</span>
                    <span>Avg Vol: {formatVolume(currentSelected.avgVolume)}</span>
                  </div>
                  <Separator className="my-4" />
                  <SignalLayerBar layers={currentSelected.layers} />
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="h-px flex-1 bg-dashed border-t border-dashed border-accent-yellow/40" />
                    <span>Threshold: {STRATEGY.MIN_CONVICTION_SCORE}/100</span>
                    <div className="h-px flex-1 border-t border-dashed border-accent-yellow/40" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Layer Detail Tabs */}
          <Card>
            <CardContent className="p-4">
              <Tabs defaultValue="catalyst">
                <TabsList className="w-full justify-start">
                  {SIGNAL_LAYERS.map((layer) => (
                    <TabsTrigger key={layer.name} value={layer.name} className="text-xs">
                      <span style={{ color: layer.color }} className="mr-1">{"\u25CF"}</span>
                      {layer.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {SIGNAL_LAYERS.map((config) => {
                  const layer = currentSelected.layers.find((l) => l.name === config.name);
                  return (
                    <TabsContent key={config.name} value={config.name} className="mt-4">
                      <div className="space-y-3">
                        <div className="flex justify-between text-sm">
                          <span className="font-medium" style={{ color: config.color }}>
                            {config.label} Layer
                          </span>
                          <span className="text-muted-foreground">
                            Score: {layer?.score ?? 0}/25 | Source: {config.dataSource}
                          </span>
                        </div>
                        <ul className="space-y-2">
                          {layer?.signals.map((signal, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm">
                              <span style={{ color: config.color }} className="mt-1">{"\u25B8"}</span>
                              <span>{signal}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </TabsContent>
                  );
                })}
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
