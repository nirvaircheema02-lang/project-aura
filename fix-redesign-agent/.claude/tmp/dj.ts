import { readFileSync, readdirSync } from 'node:fs';
import { deterministicJudgment } from '../../src/judgment/deterministic.ts';
import { JUDGMENT_SCHEMAS } from '../../src/judgment/schema-registry.ts';
const J = readdirSync('projects/www.kenresearch.com-dealers-voice-survey/redesigns/dealers-voice-survey-page-audit-v3-redesign-20261012-104005/judgments').filter(f => f.endsWith('.bundle.json')).map(f => 'projects/www.kenresearch.com-dealers-voice-survey/redesigns/dealers-voice-survey-page-audit-v3-redesign-20261012-104005/judgments/' + f);
const stat: Record<string, [number, number]> = {};
for (const f of J) { const b = JSON.parse(readFileSync(f, 'utf8')); const d = deterministicJudgment(b.nodeId, b.prompt); const s = (stat[b.nodeId] ??= [0, 0]); s[0]++; if (d !== null && (JUDGMENT_SCHEMAS as any)[b.nodeId].safeParse(d).success) s[1]++; }
console.log(JSON.stringify(stat));
