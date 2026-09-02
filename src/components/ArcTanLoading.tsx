export function ArcTanLoading() {
  return (
    <div className="arctan-loader" role="status" aria-live="assertive" aria-label="Loading arc(Tan)">
      <div className="arctan-loader-desktop">
        <div className="arctan-loader-frame" aria-hidden="true" />
        <div className="arctan-loader-rule arctan-loader-rule-left" aria-hidden="true" />
        <div className="arctan-loader-rule arctan-loader-rule-right" aria-hidden="true" />
        <p className="arctan-loader-corner arctan-loader-top-left">NBE-1 // arc(tan)</p>
        <p className="arctan-loader-corner arctan-loader-top-right">Boot // v0.1</p>
        <p className="arctan-loader-corner arctan-loader-bottom-left">Protocol engine / ready</p>
        <p className="arctan-loader-corner arctan-loader-bottom-right">Node / omega-7</p>
        <div className="arctan-loader-spark" aria-hidden="true" />
        <div className="arctan-loader-column" aria-hidden="true">{Array.from({ length: 7 }).map((_, index) => <i key={index} />)}</div>
        <div className="arctan-loader-scan" aria-hidden="true" />
        <div className="arctan-loader-mark"><p>The form, resolving.</p><strong>arc<span>(</span>tan<span>)</span></strong></div>
        <div className="arctan-loader-progress"><div><i /></div><p><span>Syncing protocol</span><span>100%</span></p></div>
        <div className="arctan-loader-telemetry"><span>› init.protocol_engine ........... ok</span><span>› load.cycles[D14] ............... ok</span><span>› sync.biomarkers ................ ready</span><span>› calibrate.somatic .............. ok</span><span>› handoff ........................ complete</span></div>
        <div className="arctan-loader-bloom" aria-hidden="true" />
      </div>

      <div className="arctan-loader-mobile">
        <div className="arctan-loader-mobile-corners" aria-hidden="true" />
        <div className="arctan-loader-mobile-spark" aria-hidden="true" />
        <div className="arctan-loader-mobile-column" aria-hidden="true">{Array.from({ length: 7 }).map((_, index) => <i key={index} />)}</div>
        <div className="arctan-loader-mobile-scan" aria-hidden="true" />
        <div className="arctan-loader-mobile-mark"><p>The form, resolving.</p><strong>arc<span>(</span>tan<span>)</span></strong></div>
        <div className="arctan-loader-mobile-progress"><div><i /></div><p><span>Syncing</span><span>100%</span></p></div>
      </div>
    </div>
  );
}
