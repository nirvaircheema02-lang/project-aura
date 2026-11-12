import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { openDb } from '../../src/db/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { runCoverageQa } from '../../src/agents/b7-coverage-qa/index.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { withFirstPass, type LivePipelineDeps } from '../helpers/live-pipeline.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent } from '../../src/agents/types.ts';

/**
 * B7's recovered-item SECTION OWNERSHIP and CANONICAL ELEMENT IDENTITY, end to end (real Chromium, the real Design
 * System, no-api mode, a local page):
 *
 *  1. a mega-menu revealed from a sticky header lies over the hero — and is still the HEADER's;
 *  2. an element the page moved and re-rendered (stamp erased, layout shifted past the box tolerance) is the same
 *     element: never captured again, never a second finding id;
 *  3. the final validation merges a duplicate that did get written — and never merges genuine look-alikes.
 */

const css = `
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#111;background:#fff}
section{padding:40px;min-height:200px}
h1,h2,h3,p{margin:0 0 12px}
header{position:sticky;top:0;background:#fff;z-index:5;height:56px}
.menu{list-style:none;margin:0;padding:12px 24px} .grp{display:inline-block;position:relative}
.panel{position:absolute;top:100%;left:0;width:300px;background:#fff;border:1px solid #ddd;opacity:0;pointer-events:none}
.grp:hover .panel{opacity:1;pointer-events:auto}
.panel a{display:block;padding:6px 10px;color:#111;font-size:14px;text-decoration:none}
.panel .mh{font-size:11px;letter-spacing:.1em;text-transform:uppercase;margin:8px 10px 4px}
`;

/** A sticky header whose mega-menu opens over a tall hero (the real audit's "All Reports" / "SURVEY VERTICALS" on the Dealers Voice hero). */
const megaHtml = `<!doctype html><html><head><style>${css}</style></head><body>
<header><nav aria-label="Main"><ul class="menu"><li class="grp"><button type="button" style="font-size:15px;padding:6px 12px">Reports</button>
<div class="panel"><p class="mh">SURVEY VERTICALS</p><a href="#r0">All Reports</a><a href="#r1">Dealer Voice</a><a href="#r2">Consumer Pulse</a></div></li></ul></nav></header>
<main>
<section aria-label="Hero" style="height:520px"><h1 style="font:300 40px 'Noto Serif',Georgia,serif">Your Dealers Know What Your Data Doesn’t</h1><p>Hear it from them first.</p></section>
<section aria-label="Method" style="height:420px"><h2 style="font:300 31px 'Noto Serif',Georgia,serif">How We Capture Dealer Needs</h2><p>Structured interviews across the network.</p></section>
</main></body></html>`;

let dir: string;
let deps: LivePipelineDeps;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
const url = (path: string) => `${server.origin}${path}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-b7-own-'));
  const config = loadConfig();
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  server = await startLocalServer({ '/mega': { body: megaHtml } });
  deps = { db: openDb(join(dir, 'audit.db')), registry: await loadDsRegistry(config.designSystemPath), config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'shots') };
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  deps?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const componentOf = (b4: B4Output, label: RegExp): DetectedComponent => {
  const c = b4.components.find((x) => label.test(x.label));
  if (!c) throw new Error(`no component labelled ${label}`);
  return c;
};
const findingOf = (findings: Finding[], label: RegExp): Finding => {
  const f = findings.find((x) => label.test(x.component.productionLabel));
  if (!f) throw new Error(`no finding labelled ${label}`);
  return f;
};
const MENU = ['All Reports', 'Dealer Voice', 'Consumer Pulse', 'SURVEY VERTICALS'];

describe('a header mega-menu revealed over the hero stays in the Header', () => {
  it('every recovered menu item is filed under the Header — the section of the Reports button — and never under the hero it lies over', async () => {
    await withFirstPass(url('/mega'), deps, async (session, firstPass) => {
      const { state, ledger, records } = await runCoverageQa(session, firstPass);
      const trigger = records.find((r) => r.raw.text === 'Reports' && r.raw.kind === 'control');
      expect(trigger?.sectionName).toMatch(/header/i);
      const hero = firstPass.sections.find((s) => /Hero|Your Dealers/i.test(s.name));
      expect(hero, 'B1 found the hero as its own section').toBeDefined();
      for (const text of MENU) {
        const r = records.find((x) => x.raw.text === text);
        expect(r?.state, text).toBe('AUDITED');
        expect(r?.sectionId, `${text} is owned by the header's subtree`).toBe(trigger?.sectionId);
        expect(r?.sectionId).not.toBe(hero?.id);
        // …and the FINDING written for it says so (the section is revalidated before the finding is written)
        const f = findingOf(state.findings, new RegExp(`^${text}$`));
        expect(f.location.sectionId, `${text} finding`).toBe(trigger?.sectionId);
        expect(f.location.section).not.toBe(hero?.name);
        // the ledger's own account of why
        expect(ledger.actions.find((a) => a.label === text && a.route === 'B2')?.reason, text).toMatch(/\((dom-subtree|trigger|region|component|adopted)\)/);
      }
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 });
    });
  }, 300_000);
});

describe('an element the page moved and re-rendered is the SAME element — one finding, never two', () => {
  it('stamps erased AND the whole layout pushed 300px down (past every box test) → nothing the audit held is captured again; every finding id survives', async () => {
    await withFirstPass(url('/mega'), deps, async (session, firstPass) => {
      await session.page.evaluate(() => {
        document.querySelectorAll('[data-audit-el]').forEach((el) => el.removeAttribute('data-audit-el'));
        const spacer = document.createElement('div');
        spacer.style.height = '300px';
        document.querySelector('main')!.prepend(spacer);
      });
      const { state, ledger, records } = await runCoverageQa(session, firstPass);
      const heading = records.find((x) => x.raw.text === 'How We Capture Dealer Needs')!;
      expect(heading.state).toBe('AUDITED');
      expect(heading.finding?.identity.findingId).toBe(findingOf(firstPass.findings, /^How We Capture Dealer Needs$/).identity.findingId);
      for (const f of firstPass.findings) {
        const label = f.component.productionLabel;
        expect(state.findings.filter((x) => x.component.productionLabel === label), label).toHaveLength(firstPass.findings.filter((x) => x.component.productionLabel === label).length);
        expect(state.findings.some((x) => x.identity.findingId === f.identity.findingId), `${label} keeps its finding id`).toBe(true);
      }
      expect(new Set(state.findings.map((f) => f.identity.findingId)).size).toBe(state.findings.length);
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 });
    });
  }, 300_000);
});

describe('the final validation: one finding per canonical element, before the report is generated', () => {
  const duplicateOf = (b4: B4Output, label: RegExp, over: { y?: number } = {}): { doubled: B4Output; original: Finding; dup: DetectedComponent } => {
    const orig = componentOf(b4, label);
    const original = findingOf(b4.findings, label);
    const box = { ...orig.fingerprint.box, y: orig.fingerprint.box.y + (over.y ?? 0) };
    const dup = { ...orig, elId: `${orig.sectionId}-recovered-b7-99`, ref: 'e-dup', findingId: 'dup-finding-id', fingerprint: { ...orig.fingerprint, box }, domFacts: null } as DetectedComponent;
    const dupFinding = { ...original, identity: { ...original.identity, findingId: 'dup-finding-id' } } as Finding;
    const doubled: B4Output = { ...b4, components: [...b4.components, dup], matched: [...b4.matched, dup], matches: new Map(b4.matches).set(dup.ref, b4.matches.get(orig.ref)!), findings: [...b4.findings, dupFinding] };
    return { doubled, original, dup };
  };

  it('the same heading written twice (two finding ids, one DOM element) → merged into the first finding, the second id gone, the merge recorded', async () => {
    await withFirstPass(url('/mega'), deps, async (session, firstPass) => {
      const { doubled, original } = duplicateOf(firstPass, /^How We Capture Dealer Needs$/);
      expect(doubled.findings.filter((f) => /^How We Capture/.test(f.component.productionLabel))).toHaveLength(2);
      const { state, ledger } = await runCoverageQa(session, doubled);
      const mine = state.findings.filter((f) => /^How We Capture/.test(f.component.productionLabel));
      expect(mine).toHaveLength(1);
      expect(mine[0]?.identity.findingId).toBe(original.identity.findingId);
      expect(state.findings.some((f) => f.identity.findingId === 'dup-finding-id')).toBe(false);
      expect(state.components.some((c) => c.findingId === 'dup-finding-id')).toBe(false);
      expect(ledger.actions.some((a) => /merged into it, not audited a second time/.test(a.reason))).toBe(true);
      expect(new Set(state.findings.map((f) => f.identity.findingId)).size).toBe(state.findings.length);
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 });
    });
  }, 300_000);

  it('a look-alike that shares the path but sits 400px away while the first element is still live is NOT merged — it is a different element', async () => {
    await withFirstPass(url('/mega'), deps, async (session, firstPass) => {
      const { doubled } = duplicateOf(firstPass, /^How We Capture Dealer Needs$/, { y: 400 });
      const { state, ledger } = await runCoverageQa(session, doubled);
      expect(state.findings.filter((f) => /^How We Capture/.test(f.component.productionLabel))).toHaveLength(2);
      expect(ledger.actions.some((a) => /merged into it/.test(a.reason))).toBe(false);
    });
  }, 300_000);
});
