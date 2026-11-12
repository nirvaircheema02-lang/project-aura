import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chapters } from './content.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'..');const repo=resolve(root,'fix-redesign-agent');
const config=JSON.parse(await readFile(resolve(repo,'fix-redesign-agent.config.json'),'utf8'));
const ranges=[
 ['AGENTS.md','AGENTS.md',1,45], ['docs/REDESIGN_RULES.md','docs/REDESIGN_RULES.md',1,60],
 ['docs/REDESIGN_RULES.md#locked','docs/REDESIGN_RULES.md',286,345],
 ['.claude/skills/fix-redesign/SKILL.md','.claude/skills/fix-redesign/SKILL.md',1,119],
 ['.claude/skills/fix-redesign/references/design-review-resolution.md','.claude/skills/fix-redesign/references/design-review-resolution.md',1,161],
 ['src/pipeline.ts','src/pipeline.ts',36,50], ['src/pipeline.ts#loop','src/pipeline.ts',280,345],
 ['src/cli/index.ts','src/cli/index.ts',268,290],
 ['src/agents/r1-resolve-load/index.ts','src/agents/r1-resolve-load/index.ts',78,143],
 ['src/agents/r3-redesign-plan/index.ts','src/agents/r3-redesign-plan/index.ts',14,145],
 ['src/agents/r5-compare/verdict.ts','src/agents/r5-compare/verdict.ts',1,32],
 ['src/agents/r8-react-preview/index.ts','src/agents/r8-react-preview/index.ts',120,235],
 ['src/preview/verify.ts','src/preview/verify.ts',310,390], ['src/preview/g2-guard.ts','src/preview/g2-guard.ts',1,37],
 ['src/llm/provider.ts','src/llm/provider.ts',1,52], ['src/config/schema.ts','src/config/schema.ts',16,48],
 ['src/config/schema.ts#budget','src/config/schema.ts',105,125],
 ['src/judgment/deterministic.ts','src/judgment/deterministic.ts',1,52],
 ['src/fidelity/loop.ts','src/fidelity/loop.ts',1,40],
 ['src/preview/status.ts','src/preview/status.ts',1,60],
 ['src/preview/user-style-rules.ts','src/preview/user-style-rules.ts',1,60],
 ['src/preview/structural.ts','src/preview/structural.ts',1,45],
 ['templates/react-preview/src/runtime/cardFocus.ts','templates/react-preview/src/runtime/cardFocus.ts',1,37],
 ['src/preview/figma-export.ts','src/preview/figma-export.ts',1,25],
 ['scripts/figma-export/prepare.mjs','scripts/figma-export/prepare.mjs',1,60],
 ['src/ds/d2-registry/index.ts','src/ds/d2-registry/index.ts',1,52], ['src/preview/plan.ts','src/preview/plan.ts',45,110],
 ['src/audit-link/fix-plan-schema.ts','src/audit-link/fix-plan-schema.ts',1,74], ['src/redesign-policy.ts','src/redesign-policy.ts',1,150],
];
const sources={};
for(const [key,path,start,end] of ranges){
 const raw=await readFile(resolve(repo,path),'utf8');
 sources[key]={start,content:raw.split('\n').slice(start-1,end).join('\n'),sha256:createHash('sha256').update(raw).digest('hex')};
}
const runPath='projects/www.kenresearch.com-cndp-survey/redesigns/cndp-survey-page-audit-v4-redesign-20261028-090140';
const run=JSON.parse(await readFile(resolve(repo,runPath,'run.json'),'utf8'));
const vraw=await readFile(resolve(repo,runPath,'preview/verification.json'),'utf8');const v=JSON.parse(vraw);
const counts={};for(const f of v.findings)counts[f.status]=(counts[f.status]??0)+1;
const status=v.status??{};
const fm=JSON.parse(await readFile(resolve(repo,runPath,'figma-export/manifest.json'),'utf8').catch(()=>'null'));
const sample={runPath,runId:run.redesignRunId,runOutcome:run.runOutcome,mode:run.mode,verdict:v.verdict,status:{verdict:status.verdict,failedRequired:status.failedRequired,unverifiedRequired:status.unverifiedRequired,gaps:(status.gaps??[]).slice(0,4).map(g=>({kind:g.kind,count:g.count,text:g.text.slice(0,150)}))},summary:v.summary,counts,examples:[v.findings.find(f=>f.status==='fixed-verified'),v.findings.find(f=>f.status==='unresolved')].filter(Boolean),figma:fm?{page:fm.page,version:fm.version,sections:fm.sections.length}:null,sha256:createHash('sha256').update(vraw).digest('hex')};
const budget={maxCorrectionCycles:config.fidelity?.maxCorrectionCycles??2,maxVerifications:config.fidelity?.maxVerifications??3,maxDurationMinutes:config.fidelity?.maxDurationMinutes??15};
const data={snapshotDate:'31 October 2026',config:{projectPath:repo,auditPath:config.auditAgentRepoRoot,dsPath:config.designSystemPath,maxIterations:config.maxIterations??3,provider:config.judgmentProvider??'claude-session',deterministicJudgments:config.deterministicJudgments===true,dsFirst:config.preview?.dsFirst===true,figmaExport:config.preview?.figmaExport!==false,budget},sources,sample};
const tokens=await readFile(resolve(config.designSystemPath,'tokens/build/tokens.css'),'utf8');
const font=(await readFile(resolve(here,'assets/dm-sans-latin.woff2'))).toString('base64');
const css=await readFile(resolve(here,'style.css'),'utf8');const js=await readFile(resolve(here,'app.js'),'utf8');
const template=await readFile(resolve(here,'guide.template.html'),'utf8');
const output=template.replace('/*__STYLE__*/',tokens+`\n@font-face{font-family:'DM Sans';font-style:normal;font-weight:100 1000;font-display:swap;src:url(data:font/woff2;base64,${font}) format('woff2')}\n`+css)
 .replace('<!--__CHAPTERS__-->',chapters.map((c,i)=>`<section class="chapter" id="${c.id}" data-title="${c.title}" ${i?'hidden':''}><div class="section-head"><p class="eyebrow">${String(i+1).padStart(2,'0')} / ${c.title}</p><h1>${c.heading}</h1><p class="lead">${c.intro}</p></div>${c.html}</section>`).join('\n'))
 .replace('/*__DATA__*/',()=>JSON.stringify(data).replaceAll('<','\\u003c')).replace('/*__APP__*/',()=>js);
await mkdir(resolve(here,'dist'),{recursive:true});await writeFile(resolve(here,'dist/index.html'),output);
console.log(`Built ${Math.round(Buffer.byteLength(output)/1024)} KB standalone guide; ${chapters.length} chapters, ${Object.keys(sources).length} source excerpts.`);
