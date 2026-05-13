"use client";

import { Activity, Bot, Briefcase, Settings, ShieldAlert, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { BackgroundMesh } from "./BackgroundMesh";
import { GlassPanel } from "./GlassPanel";
import { PriceTicker } from "./PriceTicker";
import { OverviewTab } from "./tabs/Overview";
import { PositionsTab } from "./tabs/Positions";
import { SignalEngineTab } from "./tabs/SignalEngine";
import { RiskTab } from "./tabs/Risk";
import { SettingsTab } from "./tabs/Settings";
import { ComputerUseTab } from "./tabs/ComputerUse";

type TabId =
  | "Overview"
  | "Positions"
  | "Signal Engine"
  | "Risk"
  | "Computer Use"
  | "Settings";

const TABS: Array<{ id: TabId; icon: React.ReactNode }> = [
  { id: "Overview",       icon: <Activity size={18} /> },
  { id: "Positions",      icon: <Briefcase size={18} /> },
  { id: "Signal Engine",  icon: <Zap size={18} /> },
  { id: "Risk",           icon: <ShieldAlert size={18} /> },
  { id: "Computer Use",   icon: <Bot size={18} /> },
  { id: "Settings",       icon: <Settings size={18} /> },
];

export function DeltaShell() {
  const [active, setActive] = useState<TabId>("Overview");
  const [clock, setClock] = useState<string>("");

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString("en-US", {
          hour12: false,
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
          fractionalSecondDigits: 3,
        }),
      );
    tick();
    const t = setInterval(tick, 50);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen text-slate-800 font-sans selection:bg-pink-200 p-4 md:p-8 flex items-center justify-center">
      <BackgroundMesh />

      <div className="w-full max-w-[1600px] h-[90vh] flex flex-col md:flex-row gap-6 relative z-10">
        {/* Sidebar */}
        <GlassPanel
          className="w-full md:w-24 md:h-full flex flex-row md:flex-col items-center py-8 px-4 justify-between"
          withCorners
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-white to-white/40 shadow-inner flex items-center justify-center border border-white/80 mb-8 relative group cursor-pointer">
              <div className="absolute inset-0 rounded-2xl bg-fuchsia-400/20 blur-md opacity-0 group-hover:opacity-100 transition-opacity" />
              <span className="font-bold text-xl tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-slate-800 to-slate-500">
                Δ
              </span>
            </div>

            <div className="flex md:flex-col gap-4 w-full">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActive(tab.id)}
                  className={`relative p-4 rounded-2xl flex items-center justify-center transition-all duration-300 ${
                    active === tab.id
                      ? "bg-white shadow-[0_4px_20px_rgba(0,0,0,0.05)] text-fuchsia-600 border border-white/80 scale-105"
                      : "text-slate-400 hover:text-slate-600 hover:bg-white/50"
                  }`}
                  title={tab.id}
                >
                  {tab.icon}
                  {active === tab.id && (
                    <span className="absolute -right-1 w-1.5 h-6 bg-fuchsia-500 rounded-full hidden md:block animate-pulse" />
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="hidden md:flex flex-col items-center gap-2 text-[8px] font-mono text-slate-400 tracking-widest mt-auto">
            <div className="w-0.5 h-8 bg-gradient-to-b from-transparent via-slate-300 to-transparent" />
            <span>SYS.OK</span>
          </div>
        </GlassPanel>

        {/* Main */}
        <div className="flex-1 flex flex-col h-full gap-6 overflow-hidden">
          <GlassPanel className="h-20 flex-shrink-0 flex items-center justify-between px-8 py-0 gap-6" withCorners>
            <div className="flex items-center gap-6 shrink-0">
              <h1 className="text-2xl font-light tracking-tight text-slate-800">
                <span className="font-semibold">Δ CORE</span>
                <span className="ml-3 text-xs font-mono text-slate-500">· NBE-Theta</span>
              </h1>
            </div>
            <PriceTicker />
            <div className="text-right shrink-0">
              <div className="text-[10px] font-mono text-slate-500">T-SYNC // UTC</div>
              <div className="text-sm font-mono font-medium text-slate-800 tabular-nums">{clock}</div>
            </div>
          </GlassPanel>

          <div className="flex-1 overflow-y-auto pr-2 pb-2 custom-scrollbar">
            {active === "Overview"      && <OverviewTab />}
            {active === "Positions"     && <PositionsTab />}
            {active === "Signal Engine" && <SignalEngineTab />}
            {active === "Risk"          && <RiskTab />}
            {active === "Computer Use"  && <ComputerUseTab />}
            {active === "Settings"      && <SettingsTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
