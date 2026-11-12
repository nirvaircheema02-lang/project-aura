import { useEffect, useState } from 'react';
import { SIMULATED_EVENT } from './behaviors';
import { readStatus, statusLine, type PvStatus } from './status';

const font = "'DM Sans', sans-serif";

/** Never green unless every required check is verified. */
const verdictColor = (v: PvStatus['verdict']) => (v === 'pass' ? '#166534' : v === 'fail' ? '#991b1b' : v === 'incomplete' ? '#92400e' : '#404040');

function useStatus(): PvStatus | null {
  const [status, setStatus] = useState<PvStatus | null>(null);
  useEffect(() => { fetch('/pv-status.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((raw) => setStatus(readStatus(raw))).catch(() => setStatus(null)); }, []);
  return status;
}

/** Top bar: what this is, in one line. */
export function PreviewBar() {
  const s = useStatus();
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail as { kind: string; section: string }; setToast(`Preview only: a ${d.kind.replace('-', ' ')} in "${d.section}" was not sent.`); window.setTimeout(() => setToast(null), 4000); };
    window.addEventListener(SIMULATED_EVENT, on);
    return () => window.removeEventListener(SIMULATED_EVENT, on);
  }, []);
  return (
    <>
      <header data-pv-chrome style={{ padding: '10px 24px', background: '#fff', color: '#404040', display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 12, borderBottom: '1px solid #e5e5e5', fontFamily: font }}>
        <span>React preview{s ? ` · ${s.mode} · ${s.sections.length} section${s.sections.length === 1 ? '' : 's'} · run ${s.runId}` : ''}</span>
        {s && <strong data-pv-verification={s.verdict ?? 'pending'} style={{ color: verdictColor(s.verdict) }}>{statusLine(s)}</strong>}
        <a href="#pv-notes" onClick={() => document.getElementById('pv-notes')?.setAttribute('open', '')} style={{ textDecoration: 'underline' }}>Required checks, simulated or not reproduced</a>
      </header>
      {toast && <div role="status" style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 99999, background: '#0a0a0a', color: '#fff', padding: '10px 16px', borderRadius: 8, fontSize: 13, fontFamily: font }}>{toast}</div>}
    </>
  );
}

/** Bottom notes: the always-visible statement of what is simulated or not reproduced. */
export function PreviewNotes() {
  const s = useStatus();
  return (
    <details id="pv-notes" data-pv-chrome style={{ padding: 24, background: '#fff', color: '#404040', fontSize: 14, borderTop: '1px solid #e5e5e5', fontFamily: font }}>
      <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Required checks, simulated or not reproduced in this preview</summary>
      <p style={{ margin: '12px 0 4px', fontWeight: 500 }}>{s ? statusLine(s) : '(status file not loaded)'}</p>
      {s && s.gaps.length > 0 && (
        <ul style={{ margin: '0 0 0 20px', listStyle: 'disc' }}>
          {s.gaps.map((g, i) => <li key={`${g.family}-${i}`}><strong>{g.kind === 'failed' ? 'Failed' : 'Not verified'}</strong> · {g.text}</li>)}
          {s.gapsTruncated > 0 && <li>…and {s.gapsTruncated} more (see verification.json)</li>}
        </ul>
      )}
      {s && s.disclosed.length > 0 && (
        <>
          <p style={{ margin: '12px 0 4px', fontWeight: 500 }}>Disclosed limitations (optional or by design; they never change the verdict)</p>
          <ul style={{ margin: '0 0 0 20px', listStyle: 'disc' }}>{s.disclosed.map((x) => <li key={x}>{x}</li>)}{s.disclosedTruncated > 0 && <li>…and {s.disclosedTruncated} more</li>}</ul>
        </>
      )}
      <p style={{ margin: '12px 0 4px', fontWeight: 500 }}>Simulated</p>
      <ul style={{ margin: '0 0 0 20px', listStyle: 'disc' }}>{(s?.simulated ?? ['(status file not loaded)']).map((x) => <li key={x}>{x}</li>)}</ul>
      <p style={{ margin: '12px 0 4px', fontWeight: 500 }}>Behaviour of the original page that is not reproduced</p>
      {s && s.unavailable.length ? <ul style={{ margin: '0 0 0 20px', listStyle: 'disc' }}>{s.unavailable.map((x) => <li key={x}>{x}</li>)}</ul> : <p style={{ margin: 0 }}>{s ? 'None detected by the interaction probes.' : '(status file not loaded)'}</p>}
    </details>
  );
}
