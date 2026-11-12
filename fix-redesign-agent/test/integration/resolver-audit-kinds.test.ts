import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/audit-link/index.ts';
import { inferElementKinds, type ElementEvidence } from '../../src/reference/element-kind.ts';

/**
 * The classifier on the REAL audits (read-only): what the three runs the project names would classify as. Only the audit's own evidence is
 * available here (production type, DS component, signals, possible DS matches) — no mapping and no page — which is the weakest input the
 * Resolver ever has, so what holds here holds with more evidence too. Skipped when the runs are not on this machine.
 */

const ROOT = '/Users/sachin/Project-aura/audit-agent/projects';
const RUNS = [
  { name: 'cndp-survey-page', dir: join(ROOT, 'www.kenresearch.com-cndp-survey/runs/cndp-survey-page'), cards: 6 },
  { name: 'dealers-voice-survey-page-audit-v2', dir: join(ROOT, 'www.kenresearch.com-dealers-voice-survey/runs/dealers-voice-survey-page-audit-v2'), cards: 6 },
  { name: 'deals-and-ipo-consulting-test', dir: join(ROOT, 'www.kenresearch.com-consulting-deals-and-ipo-consulting/runs/deals-and-ipo-consulting-test'), cards: 3 },
].filter((r) => existsSync(join(r.dir, 'data.json')));

const mtimes = (dir: string) => Object.fromEntries(readdirSync(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs]));
const evidenceOf = (f: Finding): ElementEvidence => ({
  audit: { productionType: f.component.productionType, dsComponent: f.component.dsComponent, signals: f.review?.signals ?? [], possibleMatches: (f.review?.possibleMatches ?? []).map((m) => ({ dsComponent: m.dsComponent, score: m.score })) },
  mapping: null,
  structure: null,
});
const CONTAINERS = ['card', 'panel', 'callout', 'section', 'row', 'strip', 'accordion'];
const CONTROLS = ['button', 'input'];

describe.skipIf(RUNS.length === 0)('element-kind classification of the real audits (read-only)', () => {
  for (const run of RUNS) {
    describe(run.name, () => {
      const before = mtimes(run.dir);
      const findings = (JSON.parse(readFileSync(join(run.dir, 'data.json'), 'utf8')) as { findings: Finding[] }).findings;
      const residual = findings.filter((f) => f.classification === 'NEEDS_REVIEW' || f.classification === 'UNVERIFIED');
      const kinds = (f: Finding) => inferElementKinds(evidenceOf(f)).kinds.map((k) => k.kind);

      it('every audit-typed card among the residuals is a card (anchor cards: the audit says "large clickable → card"), and nothing else is', () => {
        const cards = residual.filter((f) => f.component.productionType === 'card');
        expect(cards.length).toBe(run.cards);
        for (const f of cards) expect(kinds(f), f.identity.findingId).toContain('card');
        for (const f of residual.filter((x) => x.component.productionType !== 'card')) expect(kinds(f), `${f.component.productionType} ${f.identity.findingId}`).not.toContain('card');
      });

      it('no button, icon button, link, heading or input — residual or not — is ever a card, panel or other container', () => {
        for (const f of findings.filter((x) => ['button', 'icon-button', 'link', 'nav-link', 'section-heading', 'eyebrow', 'input'].includes(x.component.productionType))) {
          const k = kinds(f);
          expect(k.filter((x) => CONTAINERS.includes(x)), `${f.component.productionType} ${f.identity.findingId}`).toEqual([]);
        }
      });

      it('a title inside a card or an accordion trigger is part of that component, never the component', () => {
        const titles = findings.filter((f) => (f.review?.signals ?? []).some((s) => /\ba card (?:or link )?title\b|\baccordion trigger\b/.test(s)));
        for (const f of titles) {
          const r = inferElementKinds(evidenceOf(f));
          expect(r.partOf, f.identity.findingId).not.toBeNull();
          expect(r.kinds.map((k) => k.kind).filter((x) => x === 'card' || x === 'accordion'), f.identity.findingId).toEqual([]);
        }
      });

      it('productionType input is an input, and no finding gets both a container and a control kind', () => {
        for (const f of findings.filter((x) => x.component.productionType === 'input')) expect(kinds(f)).toContain('input');
        for (const f of findings) {
          const k = kinds(f);
          expect(k.some((x) => CONTAINERS.includes(x)) && k.some((x) => CONTROLS.includes(x)), f.identity.findingId).toBe(false);
        }
      });

      it('no finding is ever given more than one container kind', () => {
        for (const f of findings) expect(kinds(f).filter((x) => CONTAINERS.includes(x)).length, f.identity.findingId).toBeLessThanOrEqual(1);
      });

      it('is deterministic over the whole audit, and leaves the audit run untouched', () => {
        expect(JSON.stringify(findings.map((f) => inferElementKinds(evidenceOf(f))))).toBe(JSON.stringify(findings.map((f) => inferElementKinds(evidenceOf(f)))));
        expect(mtimes(run.dir)).toEqual(before);
      });
    });
  }
});
