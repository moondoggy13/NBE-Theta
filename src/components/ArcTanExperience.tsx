"use client";

import Link from "next/link";
import { useState } from "react";

const protocolCards = [
  ["01", "Stack", "A deliberate protocol view - never a generic checklist."],
  ["02", "Cycle", "A clear rhythm for timing, observations, and adjustment."],
  ["03", "Measure", "Make progress legible through notes, scans, and data."],
];

const libraryItems = [
  ["RT", "GLP-1", "Protocol"],
  ["BPC", "HEAL", "Recovery"],
  ["TB5", "RECOVER", "Support"],
  ["TES", "GH", "Performance"],
  ["SEM", "METAB.", "Metabolic"],
  ["DSIP", "SLEEP", "Rest"],
];

function playScreenFailure() {
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;

  const context = new AudioContextCtor();
  if (context.state === "suspended") void context.resume();
  const duration = 0.24;
  const start = context.currentTime + 0.82;
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * duration), context.sampleRate);
  const samples = buffer.getChannelData(0);

  for (let index = 0; index < samples.length; index += 1) {
    const decay = 1 - index / samples.length;
    samples[index] = (Math.random() * 2 - 1) * decay * decay;
  }

  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  source.buffer = buffer;
  filter.type = "highpass";
  filter.frequency.setValueAtTime(720, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.34, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);
  source.start(start);
  source.stop(start + duration);
  window.setTimeout(() => void context.close(), 1400);
}

export function ArcTanExperience() {
  const [returningToDesktop, setReturningToDesktop] = useState(false);
  const returnToDesktop = () => {
    if (returningToDesktop) return;
    playScreenFailure();
    setReturningToDesktop(true);
    window.setTimeout(() => window.location.assign("/"), 2350);
  };

  return (
    <main className="arctan-site">
      <div className="arctan-noise" aria-hidden="true" />
      <button type="button" className="arctan-return" onClick={returnToDesktop}>← Return to NBE desktop</button>

      <header className="arctan-nav">
        <Link href="/arc-tan" className="arctan-wordmark" aria-label="arc(Tan) home">arc<span>(tan)</span></Link>
        <p>Protocol companion / 2026</p>
        <a href="#protocol">Explore the system ↓</a>
      </header>

      <section className="arctan-hero">
        <div className="arctan-hero-copy">
          <p className="arctan-eyebrow">{"// Peptide protocol companion"}</p>
          <h1>arc<span>(tan)</span></h1>
          <p className="arctan-hero-dek">For those sculpting their physical and cognitive form.</p>
          <p className="arctan-hero-note">A private instrument for organizing protocols, cycles, and the work of becoming.</p>
          <div className="arctan-hero-meta">
            <span>01 / Today + cycle</span><span>02 / Stack builder</span><span>03 / Somatic scan</span>
          </div>
        </div>
        <div className="arctan-sculpture" aria-label="Copper and glass arc(Tan) form">
          <div className="arctan-sculpture-image" />
          <div className="arctan-sculpture-glass arctan-glass-one" />
          <div className="arctan-sculpture-glass arctan-glass-two" />
          <p>FORM / PROTOCOL / RESULT</p>
        </div>
      </section>

      <section className="arctan-manifesto" id="protocol">
        <p className="arctan-eyebrow">{"// The practice"}</p>
        <h2>The body is the marble.<br /><em>You bring the chisel.</em></h2>
        <p>arc(Tan) makes the invisible parts of a personal protocol easier to see: what changed, what held, and what needs attention.</p>
      </section>

      <section className="arctan-protocols" aria-label="The arc(Tan) framework">
        {protocolCards.map(([index, title, text]) => (
          <article key={title}>
            <span>{index}</span>
            <h3>{title}</h3>
            <p>{text}</p>
            <i aria-hidden="true">↗</i>
          </article>
        ))}
      </section>

      <section className="arctan-library">
        <div className="arctan-library-copy">
          <p className="arctan-eyebrow">{"// The library"}</p>
          <h2>One molecule for every <em>part of becoming.</em></h2>
          <p>An ordered visual index for your research and clinician-guided plans.</p>
        </div>
        <div className="arctan-library-grid">
          {libraryItems.map(([code, category, title], index) => (
            <article key={code} className={`arctan-library-card arctan-library-card-${index + 1}`}>
              <div aria-hidden="true" /><b>{code}</b><span>{category}</span><small>{title}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="arctan-closing">
        <p className="arctan-eyebrow">{"// Invite only"}</p>
        <h2>Form is a practice.</h2>
        <p>arc(Tan) is being shaped as a private experience. It does not provide medical advice or replace care from a qualified clinician.</p>
        <a href="mailto:automation@nbetechnologies.com" className="arctan-access">Request early access <span>→</span></a>
      </section>

      <footer className="arctan-footer"><span>NB&E Technologies</span><span>arc(Tan) / protocol companion</span><button type="button" onClick={returnToDesktop}>Desktop</button></footer>
      {returningToDesktop && (
        <div className="retro-arctan-transition" role="status" aria-live="assertive">
          <div className="retro-arctan-transition-grid" aria-hidden="true" />
          <div className="retro-arctan-transition-ember retro-arctan-transition-ember-one" aria-hidden="true" />
          <div className="retro-arctan-transition-ember retro-arctan-transition-ember-two" aria-hidden="true" />
          <p>RETURNING / NBE DESKTOP</p>
          <strong className="retro-arctan-beach-copy">...heading back<br />to the beach</strong>
          <div className="retro-arctan-glitch" aria-hidden="true">
            <div className="retro-arctan-glitch-wide" />
            <div className="retro-arctan-glitch-dark" />
            <div className="retro-arctan-glitch-bars" />
            <div className="retro-arctan-glitch-flash" />
            <div className="retro-arctan-glitch-impact" />
          </div>
        </div>
      )}
    </main>
  );
}
