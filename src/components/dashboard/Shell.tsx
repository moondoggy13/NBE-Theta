"use client";

import {
  Activity,
  ArrowDownToLine,
  BarChart3,
  ChevronRight,
  CircleHelp,
  Copy,
  Crosshair,
  Crown,
  Eye,
  Gauge,
  LayoutDashboard,
  Play,
  Plus,
  Radar,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  WalletCards,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

type View = "Command Center" | "Copy Desk" | "Positions" | "Activity" | "Controls";

const views: Array<{ id: View; icon: React.ReactNode }> = [
  { id: "Command Center", icon: <LayoutDashboard size={17} /> },
  { id: "Copy Desk", icon: <Copy size={17} /> },
  { id: "Positions", icon: <WalletCards size={17} /> },
  { id: "Activity", icon: <Activity size={17} /> },
  { id: "Controls", icon: <SlidersHorizontal size={17} /> },
];

const traders = [
  { name: "northstar", address: "0x9C6d...A671", tier: "Tier 01", winRate: "68.4%", volume: "$1.82m", focus: "Politics / macro", status: "Watching", score: 94, color: "lime" },
  { name: "quorum", address: "0xB231...0F04", tier: "Tier 01", winRate: "64.1%", volume: "$884k", focus: "Crypto / policy", status: "Watching", score: 88, color: "sky" },
  { name: "bracket", address: "0x827A...F8D2", tier: "Tier 02", winRate: "61.7%", volume: "$611k", focus: "Sports / events", status: "Review", score: 76, color: "violet" },
];

const queue = [
  { market: "Will the Fed cut rates in September?", side: "YES", source: "northstar", size: "$0.00", probability: "71¢", status: "Awaiting allocation" },
  { market: "Will BTC close above $120k this week?", side: "NO", source: "quorum", size: "$0.00", probability: "39¢", status: "Watching source" },
  { market: "Will the next CPI print exceed 3.0%?", side: "YES", source: "northstar", size: "$0.00", probability: "28¢", status: "Risk review" },
];

const activity = [
  ["WATCHER", "northstar added to the observation set", "Just now"],
  ["RISK", "Copy allocation is staged at 0%", "01m ago"],
  ["NETWORK", "Polygon wallet monitor is ready", "03m ago"],
  ["SYSTEM", "Theta execution policy loaded", "06m ago"],
];

function Marker({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border-l border-white/10 pl-4 first:border-l-0 first:pl-0">
      <div className="text-[9px] uppercase tracking-[.16em] text-[#8d99a5]">{label}</div>
      <div className={`mt-1 font-mono text-sm tabular-nums ${accent ? "text-[#d7ff7a]" : "text-[#f3f5f2]"}`}>{value}</div>
    </div>
  );
}

function ConsoleTitle({ eyebrow, title, note }: { eyebrow: string; title: string; note: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="m-0 font-mono text-[10px] uppercase tracking-[.17em] text-[#b9cf6d]">{eyebrow}</p>
        <h2 className="mt-2 text-2xl font-medium tracking-[-.055em] text-[#f3f5f2] md:text-3xl">{title}</h2>
      </div>
      <p className="max-w-sm text-right text-xs leading-5 text-[#9ca7af]">{note}</p>
    </div>
  );
}

export function DeltaShell() {
  const [active, setActive] = useState<View>("Command Center");
  const [clock, setClock] = useState("");
  const [copiedTraders, setCopiedTraders] = useState<string[]>(["northstar"]);
  const [autoCopy, setAutoCopy] = useState(false);
  const [maxAllocation, setMaxAllocation] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  function toggleTrader(name: string) {
    setCopiedTraders((current) => current.includes(name) ? current.filter((trader) => trader !== name) : [...current, name]);
  }

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3300);
  }

  return (
    <main className="min-h-screen bg-[#0c1115] px-3 py-3 text-[#f3f5f2] selection:bg-[#d7ff7a] selection:text-[#101512] md:px-5 md:py-5">
      <div className="pointer-events-none fixed inset-0 opacity-60" style={{ backgroundImage: "radial-gradient(circle at 70% -20%, rgba(177, 211, 93, .12), transparent 30%), radial-gradient(circle at 10% 100%, rgba(104, 152, 176, .12), transparent 28%)" }} />
      <div className="pointer-events-none fixed inset-0 opacity-[.14]" style={{ backgroundImage: "linear-gradient(rgba(199, 211, 216, .18) 1px, transparent 1px), linear-gradient(90deg, rgba(199, 211, 216, .18) 1px, transparent 1px)", backgroundSize: "44px 44px", maskImage: "linear-gradient(to bottom, black, transparent 90%)" }} />

      <div className="relative mx-auto flex min-h-[calc(100vh-24px)] max-w-[1720px] flex-col overflow-hidden rounded-[24px] border border-white/10 bg-[#10171b]/90 shadow-[0_24px_90px_rgba(0,0,0,.35)] md:min-h-[calc(100vh-40px)]">
        <header className="flex min-h-[74px] flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-4 md:px-7">
          <div className="flex items-center gap-4">
            <Link href="/" className="group flex items-center gap-3 no-underline">
              <span className="grid h-10 w-10 place-items-center rounded-full border border-[#d7ff7a]/60 bg-[#d7ff7a] text-xl font-medium text-[#111711] shadow-[0_0_32px_rgba(215,255,122,.18)] transition-transform group-hover:scale-105">Θ</span>
              <span><b className="block text-sm tracking-[-.04em] text-white">NB&amp;E Technologies</b><span className="font-mono text-[9px] uppercase tracking-[.18em] text-[#8d99a5]">Theta / private operator</span></span>
            </Link>
            <span className="hidden h-8 w-px bg-white/10 md:block" />
            <span className="hidden font-mono text-[10px] uppercase tracking-[.16em] text-[#c8d1d4] md:block">Polymarket copy trader</span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[.14em]">
            <span className="hidden text-[#8d99a5] sm:block">UTC {clock}</span>
            <span className="inline-flex items-center gap-2 rounded-full border border-[#d7ff7a]/25 bg-[#d7ff7a]/[.08] px-3 py-2 text-[#d7ff7a]"><i className="h-1.5 w-1.5 rounded-full bg-[#d7ff7a] shadow-[0_0_10px_#d7ff7a]" />Paper mode</span>
          </div>
        </header>

        <div className="flex flex-1 flex-col md:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 bg-[#0e1518] px-3 py-3 md:w-[232px] md:flex-col md:border-b-0 md:border-r md:px-4 md:py-5" aria-label="Terminal sections">
            <div className="hidden px-3 pb-5 font-mono text-[9px] uppercase tracking-[.18em] text-[#67757d] md:block">Workspace</div>
            {views.map((view) => (
              <button key={view.id} type="button" onClick={() => setActive(view.id)} className={`group flex shrink-0 items-center gap-3 rounded-xl px-3 py-3 text-left text-xs transition ${active === view.id ? "bg-[#d7ff7a] text-[#101512] shadow-[0_6px_22px_rgba(215,255,122,.12)]" : "text-[#a8b3b8] hover:bg-white/[.055] hover:text-white"}`}>
                {view.icon}<span className="font-medium">{view.id}</span>{active === view.id && <ChevronRight className="ml-auto" size={14} />}
              </button>
            ))}
            <div className="mt-auto hidden rounded-2xl border border-white/10 bg-white/[.025] p-4 md:block">
              <div className="flex items-center justify-between"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[#8d99a5]">Execution</span><ShieldCheck size={14} className="text-[#d7ff7a]" /></div>
              <p className="mt-3 text-xs leading-5 text-[#b5c0c3]">Orders remain simulated until a live policy and wallet signer are separately armed.</p>
            </div>
          </nav>

          <section className="min-w-0 flex-1 p-5 md:p-7">
            {active === "Command Center" && <CommandCenter copiedTraders={copiedTraders} autoCopy={autoCopy} setActive={setActive} showNotice={showNotice} />}
            {active === "Copy Desk" && <CopyDesk copiedTraders={copiedTraders} toggleTrader={toggleTrader} setActive={setActive} />}
            {active === "Positions" && <PositionsView setActive={setActive} />}
            {active === "Activity" && <ActivityView />}
            {active === "Controls" && <ControlsView autoCopy={autoCopy} setAutoCopy={setAutoCopy} maxAllocation={maxAllocation} setMaxAllocation={setMaxAllocation} showNotice={showNotice} />}
          </section>
        </div>
      </div>

      {notice && <div role="status" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-[#d7ff7a]/35 bg-[#19231e] px-4 py-3 text-xs text-[#efffd1] shadow-2xl"><ShieldCheck size={16} className="text-[#d7ff7a]" />{notice}<button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    </main>
  );
}

function CommandCenter({ copiedTraders, autoCopy, setActive, showNotice }: { copiedTraders: string[]; autoCopy: boolean; setActive: (view: View) => void; showNotice: (message: string) => void }) {
  return <>
    <ConsoleTitle eyebrow="01 / command center" title="Copy with control." note="A staged operating layer for observing selected Polymarket wallets before execution is armed." />
    <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 lg:grid-cols-4">
      <div className="bg-[#11191d] p-4"><Marker label="Capital deployed" value="$0.00" accent /></div>
      <div className="bg-[#11191d] p-4"><Marker label="Copiers enabled" value={`${copiedTraders.length} wallets`} /></div>
      <div className="bg-[#11191d] p-4"><Marker label="Copy positions" value="0 open" /></div>
      <div className="bg-[#11191d] p-4"><Marker label="Execution posture" value={autoCopy ? "Armed / paper" : "Observe only"} accent={autoCopy} /></div>
    </div>

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,.8fr)]">
      <div className="rounded-2xl border border-white/10 bg-[#0d1417] p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-[#b9cf6d]">Live leader watch</p><h3 className="mt-1 text-lg font-medium tracking-[-.04em]">Source wallets under observation</h3></div><button type="button" onClick={() => setActive("Copy Desk")} className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-[10px] font-mono uppercase tracking-[.12em] text-[#c8d1d4] transition hover:border-[#d7ff7a]/60 hover:text-[#d7ff7a]">Open copy desk <ChevronRight size={13} /></button></div>
        <div className="divide-y divide-white/10">
          {traders.map((trader) => <div key={trader.name} className="flex flex-wrap items-center gap-x-5 gap-y-3 py-4"><div className={`grid h-9 w-9 place-items-center rounded-full border ${trader.color === "lime" ? "border-[#d7ff7a]/50 bg-[#d7ff7a]/10 text-[#d7ff7a]" : trader.color === "sky" ? "border-sky-300/45 bg-sky-300/10 text-sky-200" : "border-violet-300/45 bg-violet-300/10 text-violet-200"}`}><Crown size={15} /></div><div className="min-w-[130px] flex-1"><div className="flex items-center gap-2"><b className="text-sm font-medium">{trader.name}</b>{copiedTraders.includes(trader.name) && <span className="rounded-full bg-[#d7ff7a]/10 px-2 py-0.5 font-mono text-[8px] uppercase tracking-wider text-[#d7ff7a]">copy enabled</span>}</div><span className="font-mono text-[10px] text-[#79868d]">{trader.address} / {trader.focus}</span></div><div><span className="block font-mono text-[9px] uppercase tracking-wider text-[#718087]">win rate</span><b className="font-mono text-xs text-[#d7ff7a]">{trader.winRate}</b></div><div><span className="block font-mono text-[9px] uppercase tracking-wider text-[#718087]">30d volume</span><b className="font-mono text-xs">{trader.volume}</b></div><div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#d7ff7a]" /><span className="font-mono text-[10px] text-[#aeb9be]">{trader.status}</span></div></div>)}
        </div>
      </div>
      <aside className="rounded-2xl border border-[#d7ff7a]/20 bg-[linear-gradient(145deg,rgba(215,255,122,.1),rgba(16,23,27,.3)_55%)] p-5 md:p-6"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-[#d7ff7a]">Execution status</p><Gauge size={17} className="text-[#d7ff7a]" /></div><div className="mt-8 flex items-end gap-3"><span className="text-5xl font-light tracking-[-.08em]">0</span><span className="mb-2 font-mono text-[10px] uppercase tracking-wider text-[#8d99a5]">orders sent</span></div><p className="mt-4 max-w-[27ch] text-sm leading-6 text-[#c9d1d3]">The execution queue stays empty until allocation and copy rules are configured.</p><button type="button" onClick={() => setActive("Controls")} className="mt-7 inline-flex w-full items-center justify-between rounded-xl bg-[#d7ff7a] px-4 py-3 text-xs font-semibold text-[#111711] transition hover:bg-[#eeffb9]">Configure copy rules <ChevronRight size={15} /></button></aside>
    </div>

    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,.8fr)]">
      <section className="rounded-2xl border border-white/10 bg-[#0d1417] p-5 md:p-6"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-[#b9cf6d]">Copy queue</p><h3 className="mt-1 text-lg font-medium tracking-[-.04em]">Candidate executions</h3></div><Radar size={18} className="text-[#718087]" /></div><div className="mt-5 divide-y divide-white/10">{queue.map((item) => <div key={item.market} className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_72px_94px_150px]"><div><b className="block text-sm font-medium text-[#e8eeea]">{item.market}</b><span className="font-mono text-[10px] text-[#7f8d93]">Source: {item.source}</span></div><span className={`h-fit w-fit rounded px-2 py-1 font-mono text-[10px] ${item.side === "YES" ? "bg-[#d7ff7a]/10 text-[#d7ff7a]" : "bg-sky-300/10 text-sky-200"}`}>{item.side} {item.probability}</span><span className="font-mono text-xs text-[#c3cdd1]">{item.size}</span><span className="font-mono text-[10px] text-[#849198]">{item.status}</span></div>)}</div></section>
      <section className="rounded-2xl border border-white/10 bg-[#0d1417] p-5 md:p-6"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-[#b9cf6d]">Operator note</p><CircleHelp size={16} className="text-[#718087]" /></div><p className="mt-5 text-sm leading-6 text-[#c4ced1]">This console is a product interface for the upcoming Polymarket integration. Current sources and orders are staged, not live market activity.</p><button type="button" onClick={() => showNotice("The execution policy is already in paper mode.")} className="mt-6 inline-flex items-center gap-2 text-xs text-[#d7ff7a] hover:text-white"><Play size={14} />Review paper execution</button></section>
    </div>
  </>;
}

function CopyDesk({ copiedTraders, toggleTrader, setActive }: { copiedTraders: string[]; toggleTrader: (name: string) => void; setActive: (view: View) => void }) {
  return <>
    <ConsoleTitle eyebrow="02 / copy desk" title="Select the behavior to mirror." note="Build a narrow, high-conviction wallet set. Each source remains subject to individual copy limits." />
    <div className="grid gap-5 lg:grid-cols-3">{traders.map((trader) => { const selected = copiedTraders.includes(trader.name); return <article key={trader.name} className={`relative overflow-hidden rounded-2xl border p-5 transition ${selected ? "border-[#d7ff7a]/45 bg-[#d7ff7a]/[.055]" : "border-white/10 bg-[#0d1417]"}`}><div className="absolute right-0 top-0 h-28 w-28 rounded-full bg-[#d7ff7a]/[.07] blur-3xl" /><div className="relative"><div className="flex items-start justify-between"><span className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.13em] text-[#a7b3b8]">{trader.tier}</span><span className="font-mono text-[10px] text-[#d7ff7a]">score {trader.score}/100</span></div><h3 className="mt-7 text-2xl font-medium tracking-[-.06em]">{trader.name}</h3><p className="mt-1 font-mono text-[10px] text-[#7f8d93]">{trader.address}</p><div className="mt-7 grid grid-cols-2 gap-3"><StatTile label="Win rate" value={trader.winRate} /><StatTile label="30d volume" value={trader.volume} /><StatTile label="Focus" value={trader.focus} wide /></div><button type="button" onClick={() => toggleTrader(trader.name)} className={`mt-7 flex w-full items-center justify-between rounded-xl px-4 py-3 text-xs font-semibold transition ${selected ? "bg-[#d7ff7a] text-[#111711]" : "border border-white/15 bg-white/[.04] text-[#e7ece9] hover:border-[#d7ff7a]/55"}`}>{selected ? "Copy enabled" : "Add to copy set"}{selected ? <ShieldCheck size={15} /> : <Plus size={15} />}</button></div></article>})}</div>
    <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[#0d1417] p-5"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-white/[.05] text-[#d7ff7a]"><Eye size={17} /></span><div><b className="block text-sm font-medium">Need a new source?</b><span className="text-xs text-[#87949b]">Wallet discovery will be added with the Polymarket observation layer.</span></div></div><button type="button" onClick={() => setActive("Controls")} className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-3 text-xs text-[#d7ff7a] hover:border-[#d7ff7a]/60">Set allocation policy <ChevronRight size={15} /></button></div>
  </>;
}

function PositionsView({ setActive }: { setActive: (view: View) => void }) {
  return <>
    <ConsoleTitle eyebrow="03 / positions" title="Nothing is copied yet." note="Open positions will appear here only after a wallet source, allocation, and risk policy are all enabled." />
    <div className="grid min-h-[440px] place-items-center rounded-2xl border border-dashed border-white/15 bg-[#0d1417] p-6 text-center"><div className="max-w-md"><span className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-[#d7ff7a]/30 bg-[#d7ff7a]/[.06] text-[#d7ff7a]"><WalletCards size={23} /></span><h3 className="mt-6 text-xl font-medium tracking-[-.05em]">Position book is clean</h3><p className="mt-3 text-sm leading-6 text-[#9ba8ae]">No copied Polymarket positions are open. This is intentional while the terminal remains in observation and paper-execution mode.</p><button type="button" onClick={() => setActive("Copy Desk")} className="mt-7 inline-flex items-center gap-2 rounded-xl bg-[#d7ff7a] px-4 py-3 text-xs font-semibold text-[#111711]">Choose source wallets <ChevronRight size={15} /></button></div></div>
  </>;
}

function ActivityView() {
  return <>
    <ConsoleTitle eyebrow="04 / activity" title="The operator trail." note="A concise audit layer for wallet discovery, policy changes, copy decisions, and execution events." />
    <div className="rounded-2xl border border-white/10 bg-[#0d1417]">{activity.map(([type, event, time], index) => <div key={event} className="grid grid-cols-[74px_minmax(0,1fr)_70px] items-center gap-4 border-b border-white/10 px-5 py-5 last:border-0 md:px-7"><span className={`w-fit rounded px-2 py-1 font-mono text-[9px] tracking-wider ${index === 0 ? "bg-[#d7ff7a]/10 text-[#d7ff7a]" : "bg-white/[.05] text-[#a8b5bb]"}`}>{type}</span><span className="text-sm text-[#d8dfdd]">{event}</span><time className="text-right font-mono text-[10px] text-[#7f8d93]">{time}</time></div>)}</div>
  </>;
}

function ControlsView({ autoCopy, setAutoCopy, maxAllocation, setMaxAllocation, showNotice }: { autoCopy: boolean; setAutoCopy: (value: boolean) => void; maxAllocation: number; setMaxAllocation: (value: number) => void; showNotice: (message: string) => void }) {
  return <>
    <ConsoleTitle eyebrow="05 / controls" title="Define the boundaries." note="These controls are local preview settings. They do not currently submit trades, persist risk settings, or connect a wallet." />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,.72fr)]"><section className="rounded-2xl border border-white/10 bg-[#0d1417] p-5 md:p-6"><div className="flex items-start justify-between gap-5 border-b border-white/10 pb-6"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-[#b9cf6d]">Copy posture</p><h3 className="mt-2 text-lg font-medium">Automatic copy execution</h3><p className="mt-2 max-w-lg text-sm leading-6 text-[#99a7ad]">When enabled, approved source-wallet events would be allowed into the paper execution queue.</p></div><button type="button" role="switch" aria-checked={autoCopy} onClick={() => setAutoCopy(!autoCopy)} className={`relative mt-1 h-8 w-14 rounded-full border transition ${autoCopy ? "border-[#d7ff7a] bg-[#d7ff7a]" : "border-white/20 bg-white/[.07]"}`}><span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition ${autoCopy ? "left-7" : "left-1"}`} /></button></div><div className="pt-6"><div className="flex items-end justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-[#b9cf6d]">Maximum total allocation</p><p className="mt-1 text-sm text-[#99a7ad]">Capital ceiling across every enabled source wallet.</p></div><b className="font-mono text-3xl font-medium tracking-[-.06em] text-[#f1f8eb]">{maxAllocation}%</b></div><input aria-label="Maximum total allocation" type="range" min="0" max="100" step="5" value={maxAllocation} onChange={(event) => setMaxAllocation(Number(event.target.value))} className="mt-7 w-full accent-[#d7ff7a]" /><div className="mt-3 flex justify-between font-mono text-[10px] text-[#6f7e85]"><span>0%</span><span>50%</span><span>100%</span></div></div></section><aside className="rounded-2xl border border-[#d7ff7a]/20 bg-[linear-gradient(150deg,rgba(215,255,122,.1),rgba(13,20,23,.8)_50%)] p-5 md:p-6"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-[#d7ff7a]">Deployment gate</p><h3 className="mt-3 text-xl font-medium tracking-[-.05em]">Live execution remains locked.</h3><p className="mt-4 text-sm leading-6 text-[#aeb9bc]">A future production path must independently authenticate founders, confirm a signer, establish limits, and receive an explicit live-arm action.</p><button type="button" onClick={() => showNotice("Policy saved locally for this preview only.")} className="mt-7 inline-flex w-full items-center justify-between rounded-xl bg-[#d7ff7a] px-4 py-3 text-xs font-semibold text-[#111711]">Save preview policy <ArrowDownToLine size={15} /></button></aside></div>
  </>;
}

function StatTile({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={`rounded-xl border border-white/10 bg-white/[.025] p-3 ${wide ? "col-span-2" : ""}`}><span className="block font-mono text-[9px] uppercase tracking-[.13em] text-[#718087]">{label}</span><b className="mt-1 block text-xs font-medium text-[#e5ece8]">{value}</b></div>;
}
