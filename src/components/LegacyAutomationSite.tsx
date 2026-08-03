"use client";

import { Cpu, Network, QrCode, Shield, Sparkles, Waypoints, Zap } from "lucide-react";
import { createElement, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

const serviceCards = [
  { icon: Waypoints, eyebrow: "Lead Systems", title: "AI Appointment + Lead Intake", description: "Capture calls, web forms, and texts in one flow that qualifies leads and books meetings instantly.", code: "NBE-INTAKE", size: "md:col-span-2" },
  { icon: Cpu, eyebrow: "Internal Ops", title: "Operations Workflow Automation", description: "Automate repetitive back-office tasks like quoting, invoicing, reminders, and document routing.", code: "NBE-OPS", size: "" },
  { icon: Sparkles, eyebrow: "Revenue Signals", title: "Sales Pipeline Intelligence", description: "Track opportunities, trigger follow-ups, and surface at-risk deals with AI-driven signals.", code: "NBE-SALES", size: "" },
  { icon: Network, eyebrow: "Full Stack", title: "Custom Full-Stack Integrations", description: "Connect your current tools without a rip-and-replace rebuild, from CRM to accounting to inventory.", code: "NBE-SYSTEMS", size: "md:col-span-2" },
];

const supportCards = [
  { icon: Shield, eyebrow: "Local Support", title: "Madison-based, locally available support", detail: "Direct contact and close implementation feedback loops with no offshore handoff.", code: "SUP-LOCAL" },
  { icon: Cpu, eyebrow: "Tooling Fit", title: "Built to work with your current tools", detail: "CRM, calendars, forms, quoting, billing, and operations stay connected instead of replaced.", code: "SUP-STACK" },
  { icon: Zap, eyebrow: "Measured Impact", title: "Clear ROI tracking and iterative rollouts", detail: "We start with the highest-friction workflows, then expand once the gains are visible.", code: "SUP-ROI" },
];

function TiltCard({ children, className = "", innerClassName = "" }: { children: ReactNode; className?: string; innerClassName?: string }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState("perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)");
  const [glow, setGlow] = useState(0);

  return <div ref={cardRef} className={`group relative cursor-pointer rounded-2xl transition-transform duration-200 ease-out ${className}`} style={{ transform, transformStyle: "preserve-3d" }} onMouseMove={(event) => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    const y = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    setTransform(`perspective(1000px) rotateX(${y * -8}deg) rotateY(${x * 8}deg) scale3d(1.015, 1.015, 1.015)`);
    setGlow(0.6);
  }} onMouseLeave={() => { setTransform("perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)"); setGlow(0); }}>
    <div className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 blur-xl transition-opacity duration-500" style={{ opacity: glow }} />
    <div className={`relative overflow-hidden rounded-2xl border border-white/20 bg-white/5 p-8 text-white shadow-[0_8px_32px_rgba(0,0,0,.37)] backdrop-blur-xl ${innerClassName}`}><div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/10 to-transparent" />{children}</div>
  </div>;
}

function NetworkBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const parent = canvas?.parentElement;
    if (!canvas || !ctx || !parent) return;
    let raf = 0;
    let particles: Array<{ x: number; y: number; vx: number; vy: number; radius: number }> = [];
    const resize = () => { canvas.width = parent.clientWidth; canvas.height = parent.clientHeight; particles = Array.from({ length: Math.max(16, Math.floor(canvas.width * canvas.height / 18000)) }, () => ({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, vx: (Math.random() - .5) * .45, vy: (Math.random() - .5) * .45, radius: Math.random() * 1.5 + .7 })); };
    const draw = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); particles.forEach((particle, index) => { particle.x += particle.vx; particle.y += particle.vy; if (particle.x < 0 || particle.x > canvas.width) particle.vx *= -1; if (particle.y < 0 || particle.y > canvas.height) particle.vy *= -1; ctx.fillStyle = "rgba(56,189,248,.48)"; ctx.beginPath(); ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2); ctx.fill(); particles.slice(index + 1).forEach((other) => { const distance = Math.hypot(particle.x - other.x, particle.y - other.y); if (distance < 145) { ctx.strokeStyle = `rgba(56,189,248,${.18 - distance / 900})`; ctx.beginPath(); ctx.moveTo(particle.x, particle.y); ctx.lineTo(other.x, other.y); ctx.stroke(); } }); }); raf = requestAnimationFrame(draw); };
    const observer = new ResizeObserver(resize); observer.observe(parent); resize(); draw();
    return () => { observer.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  return <canvas ref={canvasRef} className="absolute inset-0 z-0 h-full w-full opacity-60" />;
}

export function LegacyAutomationSite() {
  const [splineReady, setSplineReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://unpkg.com/@splinetool/viewer@1.0.28/build/spline-viewer.js"]');
    const script = existing ?? document.createElement("script");
    if (!existing) { script.type = "module"; script.src = "https://unpkg.com/@splinetool/viewer@1.0.28/build/spline-viewer.js"; document.head.appendChild(script); }
    if (customElements.get("spline-viewer")) setSplineReady(true); else script.addEventListener("load", () => setSplineReady(true), { once: true });
    return () => { if (!existing && document.head.contains(script)) document.head.removeChild(script); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setMessage("");
    const formData = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: String(formData.get("name") ?? ""), email: String(formData.get("email") ?? ""), phone: String(formData.get("phone") ?? ""), company: String(formData.get("company") ?? ""), message: String(formData.get("message") ?? "") }) });
      if (!response.ok) throw new Error();
      event.currentTarget.reset(); setMessage("Thanks. We received your request and will follow up from automation@nbetechnologies.com.");
    } catch { setMessage("Please email automation@nbetechnologies.com and we will follow up."); } finally { setSubmitting(false); }
  }

  return <main className="relative min-h-screen overflow-hidden bg-[#0E0E12] pb-16 text-white">
    <style dangerouslySetInnerHTML={{ __html: `@import url('https://fonts.googleapis.com/css2?family=Anton&display=swap'); body{background:#0E0E12;overflow-x:hidden} spline-viewer::part(logo),spline-viewer::part(watermark),spline-viewer::part(badge),spline-viewer::part(hint),#logo,.spline-watermark,.spline-badge,.spline-logo,[class*="spline-watermark"],[class*="spline-logo"],[aria-label*="Spline"],[title*="Spline"]{display:none!important} spline-viewer{display:block;outline:none}` }} />
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden"><div className={`absolute -top-[5%] -left-[5%] h-[150%] w-[150%] scale-110 transition-opacity duration-700 ${splineReady ? "opacity-100" : "opacity-0"}`}>{createElement("spline-viewer", { "loading-anim-type": "none", url: "https://prod.spline.design/JIoQlho-wjnetmAJ/scene.splinecode", style: { width: "100%", height: "100%" } })}</div><div className="absolute inset-0 z-10 bg-[radial-gradient(circle_at_center,rgba(0,102,255,.18),transparent_45%),linear-gradient(180deg,rgba(14,14,18,.28)_0%,rgba(14,14,18,.8)_70%,#0E0E12_100%)]" /></div>
    <section className="relative z-10 h-[150vh]"><div className="sticky top-0 flex h-screen items-center justify-center overflow-hidden"><div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(0,102,255,.05)_1px,transparent_1px),linear-gradient(90deg,rgba(0,102,255,.05)_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-40" /><div className="relative h-full w-full font-['Anton',sans-serif] text-[#0066ff] uppercase drop-shadow-[0_10px_40px_rgba(0,102,255,.4)]"><h1 className="absolute top-[12vh] left-[8vw] text-[21vw] leading-[.8]">NB</h1><h1 className="absolute top-[41vh] left-1/2 -translate-x-1/2 text-[19vw] leading-[.78]">&amp;</h1><h1 className="absolute right-[11vw] bottom-[15vh] text-[21vw] leading-[.8]">E</h1></div></div></section>
    <section className="relative z-10 mx-auto max-w-7xl px-6 py-20 md:px-10"><div className="mb-10 text-center"><p className="font-mono text-[10px] uppercase tracking-[.25em] text-cyan-300">Legacy system / still online</p><h2 className="mx-auto mt-6 max-w-4xl text-3xl font-semibold tracking-tight md:text-5xl">Automation systems built for real local operations</h2></div><div className="grid grid-cols-1 gap-8 md:grid-cols-2">{serviceCards.map((card) => { const Icon = card.icon; return <TiltCard key={card.title} className={card.size} innerClassName="flex min-h-[28rem] flex-col sm:min-h-[32rem]"><div className="relative mb-10 flex items-start justify-between" style={{ transform: "translateZ(30px)" }}><div><div className="mb-1 flex items-center gap-2"><Icon className="h-6 w-6 text-cyan-400" /><span className="text-sm font-bold uppercase tracking-wider text-cyan-400">{card.eyebrow}</span></div><h3 className="bg-gradient-to-r from-white to-gray-400 bg-clip-text text-2xl font-extrabold tracking-tight text-transparent sm:text-3xl">{card.title}</h3></div><div className="rounded-lg border border-white/10 bg-white/10 p-2"><Cpu className="h-6 w-6 text-gray-300" /></div></div><div className="relative flex flex-grow flex-col justify-center" style={{ transform: "translateZ(50px)" }}><div className="relative mb-6"><div className="absolute inset-0 rounded-full bg-cyan-500 opacity-35 blur-2xl" /><div className="relative z-10 flex h-20 w-20 items-center justify-center rounded-full border border-cyan-500/50 bg-cyan-500/10 backdrop-blur-md"><Icon className="h-9 w-9 text-cyan-300" /></div></div><p className="max-w-[28rem] text-base leading-relaxed text-gray-300">{card.description}</p></div><div className="relative mt-auto flex items-end justify-between border-t border-white/10 pt-6"><div><p className="text-xs uppercase tracking-widest text-gray-400">Status</p><p className="mt-2 flex items-center gap-2 text-sm font-semibold text-gray-200"><i className="h-2 w-2 rounded-full bg-green-400" />System Online</p></div><div className="flex flex-col items-end opacity-70"><QrCode className="mb-2 h-12 w-12" /><p className="font-mono text-[10px] tracking-[.2em] text-gray-400">{card.code}</p></div></div></TiltCard>; })}</div></section>
    <section className="relative z-10 mx-auto grid max-w-7xl grid-cols-1 gap-8 px-6 py-10 md:grid-cols-3 md:px-10">{supportCards.map((card) => { const Icon = card.icon; return <TiltCard key={card.title} innerClassName="flex min-h-[20rem] flex-col"><div className="relative mb-8 flex items-start justify-between"><div className="flex items-center gap-2"><Icon className="h-5 w-5 text-cyan-400" /><span className="text-sm font-bold uppercase tracking-wider text-cyan-400">{card.eyebrow}</span></div><Sparkles className="h-5 w-5 text-gray-300" /></div><div className="relative flex flex-grow flex-col justify-between"><div><h3 className="text-xl font-bold tracking-tight">{card.title}</h3><p className="mt-4 text-sm leading-relaxed text-gray-400">{card.detail}</p></div><div className="mt-8 flex items-center justify-between border-t border-white/10 pt-5"><span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.2em] text-gray-300"><i className="h-2 w-2 rounded-full bg-green-400" />Active</span><span className="font-mono text-[10px] tracking-[.22em] text-gray-500">{card.code}</span></div></div></TiltCard>; })}</section>
    <section className="relative z-10 mx-auto max-w-7xl px-6 py-20 md:px-10"><div className="relative overflow-hidden rounded-[2.5rem] bg-[#0a0a0c]"><div className="pointer-events-none absolute top-1/3 left-12 h-72 w-72 rounded-full bg-cyan-600/15 blur-[110px]" /><div className="pointer-events-none absolute right-12 bottom-1/3 h-72 w-72 rounded-full bg-blue-600/15 blur-[110px]" /><NetworkBackground /><div className="relative z-10 p-8 md:p-12"><div className="flex flex-col gap-10 lg:flex-row lg:items-start"><div className="max-w-xl flex-1"><div className="mb-3 flex items-center gap-2"><Network className="h-6 w-6 text-cyan-400" /><span className="text-sm font-bold uppercase tracking-wider text-cyan-400">Start Here</span></div><h2 className="bg-gradient-to-r from-white to-gray-400 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent md:text-5xl">Schedule your AI automation consultation</h2><p className="mt-5 text-base leading-relaxed text-gray-300 md:text-lg">Tell us your biggest operational bottleneck and we&apos;ll map the fastest automation path for your business.</p><div className="mt-8 flex flex-wrap gap-4"><a href="https://calendar.google.com/calendar/u/0/r" target="_blank" rel="noreferrer" className="rounded-full bg-cyan-400 px-8 py-4 font-medium text-black transition hover:bg-cyan-300">Schedule Consultation</a><a href="mailto:automation@nbetechnologies.com" className="rounded-full border border-white/20 bg-white/10 px-8 py-4 font-medium text-white">Email Automation Team</a></div><p className="mt-10 border-t border-white/10 pt-6 text-sm text-gray-400">automation@nbetechnologies.com</p></div><form className="grid flex-1 gap-4 md:grid-cols-2" onSubmit={submit}><input name="name" required placeholder="Name" className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-white outline-none placeholder:text-white/35" /><input name="email" type="email" required placeholder="Email" className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-white outline-none placeholder:text-white/35" /><input name="phone" placeholder="Phone" className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-white outline-none placeholder:text-white/35" /><input name="company" placeholder="Business Name" className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-white outline-none placeholder:text-white/35" /><textarea name="message" required rows={6} placeholder="What would you like to automate?" className="resize-none rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-white outline-none placeholder:text-white/35 md:col-span-2" /><button type="submit" disabled={submitting} className="rounded-full bg-cyan-400 px-8 py-4 font-medium text-black disabled:opacity-60 md:col-span-2">{submitting ? "Submitting..." : "Submit Consultation Request"}</button>{message && <p className="text-sm text-cyan-300 md:col-span-2">{message}</p>}</form></div></div></div></section>
  </main>;
}
