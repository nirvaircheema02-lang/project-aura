import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseR3Prompt, composeR3Replay } from '../../src/judgment/replay.ts';
const J = process.argv[2]!, B = process.argv[3]!;
const prompt = JSON.parse(readFileSync(`${J}/${B}.bundle.json`, 'utf8')).prompt as string;
const priors: any[] = [];
for (const f of readdirSync(J)) if (f.endsWith('.result.json')) {
  const id = f.slice(0, -12); try { const b = JSON.parse(readFileSync(`${J}/${id}.bundle.json`, 'utf8')); const r = JSON.parse(readFileSync(`${J}/${f}`, 'utf8')); if (b.nodeId === 'R3' && r.nodeId === 'R3') priors.push({ prompt: b.prompt, data: r.data }); } catch {}
}
const now = parseR3Prompt(prompt);
const ok: string[] = [], bad: string[] = [];
const edits: any[] = [], unadr: any[] = [];
for (const id of now.order) {
  const one = { ...now } as any;
  // replay a single finding by composing on a prompt restricted to it is not possible; test per id via full compose with only this id's block
  const sub = prompt; void sub; void one;
}
// per-finding: compose with a prompt containing only that finding's block
const head = prompt.slice(0, prompt.indexOf('findingId='));
for (const id of now.order) {
  const block = now.blocks.get(id)!;
  const p = head + block + '\n' + now.tail;
  const r = composeR3Replay(p, priors);
  if (r) { ok.push(id); edits.push(...r.edits); unadr.push(...r.unaddressed); } else bad.push(id);
}
writeFileSync('.claude/tmp/partial.json', JSON.stringify({ edits, unaddressed: unadr, missing: bad }));
console.log('replayable', ok.length, 'missing', bad.length, bad.map((b) => [b.slice(0, 8), (now.blocks.get(b)!.match(/label="([^"]*)"/) ?? [])[1]]));
