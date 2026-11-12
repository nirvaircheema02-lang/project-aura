import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { openDb } from '../../src/db/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { DisabledLlmClient } from '../../src/llm/provider.ts';
import { auditPage } from '../../src/agents/page-graph.ts';
import { renderRun } from '../../src/dashboard/views/render.ts';
import { buildAuditData } from '../../src/agents/c2-json-writer/index.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import type { PageResult } from '../../src/skills/s0-result-contract.ts';

const html = `<!doctype html><style>
body{margin:0;font:16px Arial} section{padding:40px;min-height:200px} .dark{background:linear-gradient(rgb(5,5,5),rgb(12,12,12),rgb(17,17,17));color:white}
a{color:inherit}button{cursor:pointer}h1{font-size:38px}.price{font-size:32px}.title{font-size:26px;font-weight:600}
</style><main>
<section class="dark"><nav><a href="/">Home</a> ❯ <a href="/surveys" style="color:rgba(255,255,255,.7)">Surveys</a> ❯ <button>Consumer survey</button></nav><h1>Consumer survey</h1><h2 style="font-size:16px">Consumers evaluate environmental claims, compare material choices, and weigh price premiums across everyday products and categories to improve their sustainability positioning.</h2></section>
<section><div><div><p class="title">Survey investment</p></div></div><article><h2>Nested card title</h2><h2 class="price">₹2.50 L</h2><button aria-label="Search"><img width="24" height="24" src="/icon.svg" alt=""></button><button><img width="24" height="24" src="/icon.svg" alt=""></button><svg role="img" style="cursor:pointer" width="24" height="24"><circle cx="12" cy="12" r="8"/></svg><a href="/"><img width="32" height="32" src="/icon.svg" alt="Company Logo"></a></article></section>
</main>`;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
let db: ReturnType<typeof openDb>;
let dir: string;
let result: PageResult;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(),'audit-context-'));
  db = openDb(join(dir,'audit.db'));
  pool = new BrowserPool({ channel:'chromium',userAgentProduct:'KenResearchDSAudit/0.1' }); await pool.start();
  server = await startLocalServer({ '/':{body:html}, '/icon.svg':{body:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="8"/></svg>',headers:{'content-type':'image/svg+xml'}} });
  const config = loadConfig();
  result = await auditPage(server.origin+'/',{db,pool,registry:await loadDsRegistry(config.designSystemPath),config,aiMode:'no-api',llm:new DisabledLlmClient(),politeness:new Politeness(0),evidenceRoot:join(dir,'screenshots')},{runId:'context-regression'});
},180000);
afterAll(async()=>{await pool?.stop();await server?.close();db?.close();rmSync(dir,{recursive:true,force:true});});

describe('recommendations grounded in composition and source',()=>{
  it('finds an unlabelled breadcrumb hierarchy and compares dark link slots, not red TextLink',()=>{
    const links=result.findings.filter(f=>['Home','Surveys'].includes(f.component.productionLabel));
    expect(links).toHaveLength(2);
    for(const f of links){
      expect(f.component.dsComponent).toBe('Breadcrumb');
      expect(f.comparison.mismatches.some(m=>m.expectedToken==='--color-brand-red')).toBe(false);
      if(f.component.productionLabel==='Home') expect(f.comparison.mismatches.find(m=>m.property==='color')?.expected).toMatch(/255|ffffff/i);
      else expect(f.comparison.mismatches.some(m=>m.property==='color')).toBe(false);
      expect(f.component.dsVariant).toContain('dark');
    }
  });
  it('does not prescribe primary-button properties to a combined breadcrumb dropdown',()=>{
    const f=result.findings.find(f=>f.component.productionType==='button'&&f.component.productionLabel==='Consumer survey')!;
    expect(f.component.dsComponent).toBe('Breadcrumb');
    expect(f.comparison.mismatches.filter(m=>!m.property.startsWith('visual:')).every(m=>m.property.startsWith('label.'))).toBe(true);
    expect(f.comparison.properties?.some(p=>p.property==='label.font-size' && p.actual && p.expected)).toBe(true);
    expect(f.comparison.properties?.some(p=>p.property==='container.width' && p.actual && p.expected===null)).toBe(true);
    expect(f.action.recommendation).toContain('composition');
  });
  it('gives actionable library advice for image controls without guessing unlabelled glyphs or replacing logos',()=>{
    const advised=result.findings.filter(f=>f.action.recommendation.includes('lucide-react'));
    expect(advised.length).toBeGreaterThanOrEqual(3);
    expect(advised.every(f=>f.action.recommendation.includes('@phosphor-icons/react'))).toBe(true);
    expect(advised.some(f=>f.action.recommendation.includes('source React library is not verified'))).toBe(true);
    expect(advised.some(f=>f.action.recommendation.includes('exact glyph is not verified'))).toBe(true);
    expect(advised.every(f=>!f.component.productionLabel.includes('Company Logo'))).toBe(true);
    expect(advised.every(f=>f.quality.evidence.some(e=>e.ref==='audit-agent.config.json#allowedIconLibraries'))).toBe(true);
  });
  it('compares the heading child and preserves actual measurements when subtitle semantics are unresolved',()=>{
    const h=result.findings.find(f=>f.component.productionType==='section-heading' && f.component.productionLabel==='Consumer survey')!;
    // Rendered as <h1> at 38px, but the DS's level-1 heading renders at 3.052rem (~48.8px) and
    // level-2 at 2.441rem (~39.1px) — 38px is closer to level 2, so the visual variant picked is
    // level 2, independent of the DOM tag's own semantic level (h1).
    expect(h.component.dsVariant).toBe('level 2');
    expect(h.comparison.properties?.find(p=>p.property==='font-size')).toMatchObject({actual:'38px',expected:'2.441rem',status:'DIFFERENT'});
    const sub=result.findings.find(f=>f.component.productionLabel.startsWith('Consumers evaluate'))!;
    expect(sub.classification).toBe('UNVERIFIED');
    expect(sub.component.dsVariant).toBe('subtitle candidate');
    expect(sub.comparison.properties?.find(p=>p.property==='font-size')).toMatchObject({actual:'16px',status:'UNRESOLVED'});
    expect(sub.comparison.mismatches.filter(m=>!m.property.startsWith('visual:'))).toEqual([]);
  });
  it('labels a section by its visible title instead of a price',()=>{
    expect(result.sections?.some(s=>s.name==='Survey investment')).toBe(true);
    expect(result.sections?.some(s=>s.name==='₹2.50 L')).toBe(false);
  });
  it('keeps duplicate section names separately selectable and includes empty sections',async()=>{
    const data=buildAuditData({runId:'context-regression',auditId:'context-regression',mode:'single-page',startedAt:'2026-10-01',targetUrl:server.origin,pages:[result],failedPages:[]});
    data.sections=[{pageId:'p',id:'a',name:'Details',note:''},{pageId:'p',id:'b',name:'Details',note:''}];
    const markup=renderRun('Context',data,'/screenshots');
    expect(markup).toContain('value="p/a">Details (0)');
    expect(markup).toContain('value="p/b">Details (0)');
  });
});
