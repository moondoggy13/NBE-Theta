"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ConnectionStatus } from "@/components/dashboard/connection-status";
import { STRATEGY } from "@/lib/constants";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Strategy parameters, API connections, and alert preferences
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Strategy Parameters */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Strategy Parameters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Conviction Threshold</p>
                <p className="text-xs text-muted-foreground">Minimum score to enter universe</p>
              </div>
              <Input
                type="number"
                defaultValue={STRATEGY.MIN_CONVICTION_SCORE}
                className="w-20 text-right"
                disabled
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Max Positions</p>
                <p className="text-xs text-muted-foreground">Concurrent position limit</p>
              </div>
              <Input
                type="number"
                defaultValue={STRATEGY.MAX_POSITIONS_PHASE1}
                className="w-20 text-right"
                disabled
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Max Position Size</p>
                <p className="text-xs text-muted-foreground">% of total capital per trade</p>
              </div>
              <Input
                type="number"
                defaultValue={STRATEGY.MAX_POSITION_SIZE_PCT}
                className="w-20 text-right"
                disabled
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Stop Loss Range</p>
                <p className="text-xs text-muted-foreground">Below entry (hardcoded)</p>
              </div>
              <span className="text-sm text-muted-foreground">
                {STRATEGY.STOP_LOSS_MIN_PCT}% - {STRATEGY.STOP_LOSS_MAX_PCT}%
              </span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Kill Switch</p>
                <p className="text-xs text-muted-foreground">Daily loss limit</p>
              </div>
              <span className="text-sm text-accent-red font-medium">
                {STRATEGY.DAILY_LOSS_KILL_SWITCH_PCT}%
              </span>
            </div>
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              <Badge variant="outline" className="mb-1">Phase 1</Badge>
              <p>Parameters are read-only during paper trading phase. They will become configurable when the backend is connected.</p>
            </div>
          </CardContent>
        </Card>

        {/* API Connections */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">API Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <ConnectionStatus />
            <div className="mt-4 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              <p>Live connections are resolved from environment variables. Services without keys fall back to mock data automatically.</p>
            </div>
          </CardContent>
        </Card>

        {/* Alerts */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Alert Preferences</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Signal Alerts</p>
                <p className="text-xs text-muted-foreground">New conviction scores above threshold</p>
              </div>
              <Switch defaultChecked />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Trade Execution</p>
                <p className="text-xs text-muted-foreground">Entry and exit notifications</p>
              </div>
              <Switch defaultChecked />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Risk Warnings</p>
                <p className="text-xs text-muted-foreground">Kill switch proximity, stop loss approach</p>
              </div>
              <Switch defaultChecked />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Pipeline Events</p>
                <p className="text-xs text-muted-foreground">Stage transitions and errors</p>
              </div>
              <Switch />
            </div>
          </CardContent>
        </Card>

        {/* System Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">System Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Version</span>
              <span>1.0.0-alpha</span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Phase</span>
              <Badge variant="outline">Paper Trading</Badge>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Data Mode</span>
              <Badge variant="outline" className="border-accent-yellow/30 text-accent-yellow">Hybrid (Live + Mock fallback)</Badge>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Strategy</span>
              <span>High-Conviction Directional</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
