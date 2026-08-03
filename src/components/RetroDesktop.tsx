"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

type WindowId = "welcome" | "network" | "signals" | "research" | "automation" | "login" | "contact";
type WindowState = Record<WindowId, { open: boolean; x: number; y: number }>;
let sharedAudioContext: AudioContext | undefined;

const initialWindows: WindowState = {
  welcome: { open: true, x: 190, y: 86 },
  network: { open: false, x: 290, y: 122 },
  signals: { open: false, x: 390, y: 156 },
  research: { open: false, x: 245, y: 180 },
  automation: { open: false, x: 192, y: 68 },
  login: { open: false, x: 470, y: 202 },
  contact: { open: false, x: 330, y: 248 },
};

const iconData: Array<{ id: WindowId; icon: string; label: string }> = [
  { id: "network", icon: "network", label: "NBE Network" },
  { id: "signals", icon: "signal", label: "Signal Desk" },
  { id: "research", icon: "note", label: "Research Notes" },
  { id: "automation", icon: "automation", label: "Automation" },
  { id: "contact", icon: "mail", label: "Contact NB&E" },
];

function playWindowTone(kind: "open" | "close") {
  if (typeof window === "undefined") return;
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  const context = sharedAudioContext ?? new AudioContextCtor();
  sharedAudioContext = context;
  if (context.state === "suspended") void context.resume();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  const tones = { open: [660, 0.075], close: [235, 0.05] } as const;
  const [frequency, duration] = tones[kind];
  oscillator.type = kind === "open" ? "square" : "sine";
  oscillator.frequency.setValueAtTime(frequency, now);
  if (kind === "open") oscillator.frequency.setValueAtTime(880, now + 0.045);
  gain.gain.setValueAtTime(0.045, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

function PixelIcon({ type }: { type: string }) {
  return <span aria-hidden="true" className={`retro-pixel-icon retro-icon-${type}`} />;
}

function RetroWindow({
  id,
  title,
  state,
  onClose,
  onFocus,
  onDrag,
  children,
}: {
  id: WindowId;
  title: string;
  state: WindowState[WindowId];
  onClose: () => void;
  onFocus: () => void;
  onDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  if (!state.open) return null;
  return (
    <section
      className={`retro-window retro-window-${id}`}
      style={{ left: state.x, top: state.y, zIndex: state.open ? undefined : 0 }}
      onPointerDown={onFocus}
      aria-label={title}
    >
      <div className="retro-titlebar" onPointerDown={onDrag}>
        <span>{title}</span>
        <button type="button" className="retro-window-close" onPointerDown={(event) => event.stopPropagation()} onClick={onClose} aria-label={`Close ${title}`}>
          ×
        </button>
      </div>
      <div className="retro-window-body">{children}</div>
    </section>
  );
}

export function RetroDesktop() {
  const [windows, setWindows] = useState<WindowState>(initialWindows);
  const [startOpen, setStartOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [clock, setClock] = useState("--:-- --");
  const [activeWindow, setActiveWindow] = useState<WindowId>("welcome");
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const clickSound = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const updateClock = () => setClock(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    updateClock();
    const interval = window.setInterval(updateClock, 10_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const audio = new Audio("/sounds/retro-click.wav");
    audio.preload = "auto";
    audio.load();
    clickSound.current = audio;
    return () => {
      audio.pause();
      clickSound.current = null;
    };
  }, []);

  const tone = (kind: "open" | "click" | "close") => {
    if (!soundOn) return;
    if (kind === "click") {
      const player = clickSound.current?.cloneNode(true) as HTMLAudioElement | undefined;
      if (player) {
        player.volume = 0.62;
        void player.play().catch(() => undefined);
      }
      return;
    }
    playWindowTone(kind);
  };
  const openWindow = (id: WindowId) => {
    tone("open");
    setActiveWindow(id);
    setStartOpen(false);
    setWindows((current) => ({ ...current, [id]: { ...current[id], open: true } }));
  };
  const closeWindow = (id: WindowId) => {
    tone("close");
    setWindows((current) => ({ ...current, [id]: { ...current[id], open: false } }));
  };
  const focusWindow = (id: WindowId) => setActiveWindow(id);
  const beginDrag = (id: WindowId, event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const origin = windows[id];
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (moveEvent: PointerEvent) => {
      const maxX = Math.max(6, window.innerWidth - 250);
      const maxY = Math.max(6, window.innerHeight - 100);
      setWindows((current) => ({
        ...current,
        [id]: {
          ...current[id],
          x: Math.min(maxX, Math.max(6, origin.x + moveEvent.clientX - startX)),
          y: Math.min(maxY, Math.max(6, origin.y + moveEvent.clientY - startY)),
        },
      }));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const tasks = (Object.keys(windows) as WindowId[]).filter((id) => windows[id].open);

  return (
    <main
      className="retro-desktop"
      onPointerDownCapture={() => tone("click")}
      onClick={() => startOpen && setStartOpen(false)}
    >
      <div className="retro-wallpaper-copy" aria-hidden="true">OBSERVATION / EXECUTION / ITERATION</div>
      <div className="retro-desktop-icons" aria-label="Desktop shortcuts">
        {iconData.map(({ id, icon, label }) => (
          <button type="button" className="retro-desktop-icon" key={id} onClick={(event) => { event.stopPropagation(); openWindow(id); }}>
            <PixelIcon type={icon} />
            <span>{label}</span>
          </button>
        ))}
        <button type="button" className="retro-desktop-icon retro-trash">
          <PixelIcon type="trash" />
          <span>Recycle Bin</span>
        </button>
      </div>

      <button type="button" className="retro-founder-glass" onClick={() => openWindow("login")}>
        <span className="retro-glass-status" aria-hidden="true" />
        <span><b>Founder Login</b><small>Private workspace</small></span>
        <i aria-hidden="true">↗</i>
      </button>

      <RetroWindow id="welcome" title="NB&E Technologies — Welcome" state={windows.welcome} onClose={() => closeWindow("welcome")} onFocus={() => focusWindow("welcome")} onDrag={(event) => beginDrag("welcome", event)}>
        <div className="retro-welcome">
          <div className="retro-welcome-mark">NB<br /><em>&amp;</em><br />E</div>
          <div>
            <p className="retro-window-kicker">WELCOME TO NBE NETWORK</p>
            <h1>Work for the markets ahead.</h1>
            <p>NB&amp;E Technologies builds research, systems, and operating infrastructure for disciplined decisions.</p>
            <div className="retro-menu-list">
              <button type="button" onClick={() => openWindow("network")}>› Quantitative research</button>
              <button type="button" onClick={() => openWindow("signals")}>› Algorithmic operations</button>
              <button type="button" onClick={() => openWindow("research")}>› Systems engineering</button>
              <button type="button" onClick={() => openWindow("automation")}>› Intelligent automation</button>
            </div>
          </div>
        </div>
      </RetroWindow>

      <RetroWindow id="network" title="NBE Network — Properties" state={windows.network} onClose={() => closeWindow("network")} onFocus={() => focusWindow("network")} onDrag={(event) => beginDrag("network", event)}>
        <div className="retro-file-panel">
          <PixelIcon type="network" />
          <div><b>NB&E Technologies LLC</b><span>Independent systems field office</span></div>
        </div>
        <dl className="retro-specs"><div><dt>Location</dt><dd>Madison, Wisconsin</dd></div><div><dt>Field</dt><dd>Research + systems</dd></div><div><dt>Method</dt><dd>Observe / execute / iterate</dd></div></dl>
        <p className="retro-window-note">We build the infrastructure behind decisions that cannot be handled with old operating models.</p>
      </RetroWindow>

      <RetroWindow id="signals" title="Signal Desk — NBE Theta" state={windows.signals} onClose={() => closeWindow("signals")} onFocus={() => focusWindow("signals")} onDrag={(event) => beginDrag("signals", event)}>
        <div className="retro-monitor"><span className="retro-monitor-dot" /> <span>OBSERVATION ACTIVE</span><b>THETA // 2026</b></div>
        <p className="retro-window-note">Private observation environment for on-chain movement, market behavior, and Polymarket copy-trading signals.</p>
        <div className="retro-terminal-lines"><span>&gt; INTAKE: PUBLIC LEDGER</span><span>&gt; MODEL: BEHAVIORAL SIGNALS</span><span>&gt; POSTURE: WATCHING</span></div>
        <button type="button" className="retro-action-button" onClick={() => openWindow("login")}>Founder login...</button>
      </RetroWindow>

      <RetroWindow id="research" title="Research Notes — Read Me" state={windows.research} onClose={() => closeWindow("research")} onFocus={() => focusWindow("research")} onDrag={(event) => beginDrag("research", event)}>
        <article className="retro-notepad"><p className="retro-notepad-date">7/31/2026</p><h2>A long view needs a better instrument panel.</h2><p>Quantitative research. Algorithmic operations. Systems engineering. Intelligent automation.</p><p>NB&amp;E is designed to work where complex information needs to become a clear, controlled action.</p></article>
      </RetroWindow>

      <RetroWindow id="automation" title="Automation — NB&E Technologies" state={windows.automation} onClose={() => closeWindow("automation")} onFocus={() => focusWindow("automation")} onDrag={(event) => beginDrag("automation", event)}>
        <div
          className="retro-automation-portal"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="retro-portal-status" aria-hidden="true"><span />LEGACY PORTAL · AUTOMATION SYSTEMS</div>
          <iframe
            title="NB&E Technologies legacy automation systems"
            src="/legacy-automation"
            loading="eager"
            referrerPolicy="strict-origin-when-cross-origin"
            scrolling="auto"
          />
        </div>
      </RetroWindow>

      <RetroWindow id="login" title="Founder Login — NBE Theta" state={windows.login} onClose={() => closeWindow("login")} onFocus={() => focusWindow("login")} onDrag={(event) => beginDrag("login", event)}>
        <div className="retro-lock"><span className="retro-login-orb" aria-hidden="true" /><div><b>Founder Console</b><span>NBE Theta / copy-trader terminal</span></div></div>
        <p className="retro-window-note">Enter the private workspace used to observe markets, manage copy-trading activity, and operate the Theta system.</p>
        <form className="retro-login-form" onSubmit={(event) => { event.preventDefault(); setLoginMessage("Founder access is being provisioned. This form does not send or save credentials."); }}>
          <label className="retro-login-field"><span>Founder ID</span><input name="username" autoComplete="username" placeholder="Founder username" /></label>
          <label className="retro-login-field"><span>Access code</span><input name="password" type="password" autoComplete="current-password" placeholder="••••••••" /></label>
          <button type="submit" className="retro-action-button">Enter console <span aria-hidden="true">→</span></button>
          <p className="retro-login-bypass">{loginMessage ?? "Private access is not live yet — credentials are not verified or saved in this build."}</p>
        </form>
      </RetroWindow>

      <RetroWindow id="contact" title="Contact NB&E — Message" state={windows.contact} onClose={() => closeWindow("contact")} onFocus={() => focusWindow("contact")} onDrag={(event) => beginDrag("contact", event)}>
        <div className="retro-mail-head"><b>To:</b><a href="mailto:automation@nbetechnologies.com">automation@nbetechnologies.com</a></div>
        <p className="retro-window-note">For systems, research, and operations that need a different interface.</p>
        <a className="retro-action-button retro-email-button" href="mailto:automation@nbetechnologies.com">Compose message</a>
      </RetroWindow>

      {startOpen && (
        <aside className="retro-start-menu" onClick={(event) => event.stopPropagation()} aria-label="Start menu">
          <div className="retro-start-side">NBEOS <b>2026</b></div>
          <div className="retro-start-options">
            {iconData.slice(0, 5).map(({ id, icon, label }) => <button type="button" key={id} onClick={() => openWindow(id)}><PixelIcon type={icon} />{label}</button>)}
            <button type="button" onClick={() => openWindow("login")}><PixelIcon type="key" />Founder Login</button>
            <button type="button" onClick={() => setSoundOn((value) => !value)}><PixelIcon type="speaker" />Sound: {soundOn ? "On" : "Off"}</button>
          </div>
        </aside>
      )}

      <footer className="retro-taskbar" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="retro-start-button" onClick={() => setStartOpen((value) => !value)}><span className="retro-start-flag" />Start</button>
        <div className="retro-task-list">{tasks.map((id) => <button type="button" className={activeWindow === id ? "retro-task-active" : ""} key={id} onClick={() => focusWindow(id)}>{id === "welcome" ? "NB&E Technologies" : id === "signals" ? "Signal Desk" : id === "login" ? "Founder Access" : `${id[0].toUpperCase()}${id.slice(1)}`}</button>)}</div>
        <div className="retro-tray"><span className="retro-tray-signal">◢</span><span>{clock}</span></div>
      </footer>
    </main>
  );
}
