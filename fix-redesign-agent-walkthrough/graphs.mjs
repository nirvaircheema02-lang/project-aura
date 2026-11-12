const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const label = (x,y,s,cls='diagram-sub') => `<text x="${x}" y="${y}" text-anchor="middle" class="${cls}">${esc(s)}</text>`;
const node = (x,y,w,title,sub,cls='',id='') => `<g class="diagram-node ${cls}" ${id ? `data-node="${id}"` : ''}><rect x="${x}" y="${y}" width="${w}" height="66" rx="8"/>${label(x+w/2,y+25,title,'diagram-title')}${label(x+w/2,y+48,sub)}</g>`;
const edge = (id,d,dash=false) => `<path class="diagram-edge ${dash?'recovery-edge':''}" d="${d}" marker-end="url(#${id}-arrow)"/>`;
const box = (id,title,desc,h,body) => `<div class="diagram-scroll" tabindex="0" role="region" aria-label="${title}; scroll horizontally on small screens"><svg class="execution-diagram" viewBox="0 0 1000 ${h}" role="img" aria-labelledby="${id}-title ${id}-desc"><title id="${id}-title">${title}</title><desc id="${id}-desc">${desc}</desc><defs><marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="var(--semantic-ink-muted)"/></marker></defs>${body}</svg></div>`;
export function overviewGraph(){
 const id='overview';
 return box(id,'Fix & Redesign Agent system overview','Read-only audit data and DS sources feed a targeted fix pipeline. A generated React preview is measured before human approval, and a Figma bundle is built from it.',650,
 node(15,35,285,'Audit Agent · Read only','data.json + reviewed fix-plan.json','page-node')+
 node(700,35,285,'Design System · Read only','Tokens, components, variants and rules','page-node')+
 node(350,160,300,'Fix & Redesign Agent','Resolve → capture → map → scope','accent-node')+
 edge(id,'M158 101 V193 H350',true)+edge(id,'M842 101 V193 H650',true)+
 node(350,285,300,'Resolve → plan → apply → compare','RV → R3 → R4 → R5 · 1 pass','accent-node')+edge(id,'M500 226 V285')+
 node(350,410,300,'Generated React preview','R8 · build, serve and measure')+edge(id,'M500 351 V410')+
 node(350,535,300,'G2 · Your review','Preview, failed checks and finding results','gate-node')+edge(id,'M500 476 V535')+
 node(15,285,285,'Judgments','Answered automatically in this setup')+edge(id,'M300 318 H350',true)+
 label(157,387,'Deterministic mode answers C2, RV, R3, R5.')+label(157,412,'A judgment pause is not an approval gate.')+
 node(700,410,285,'Saved evidence + source','preview-app/ + verification.json','page-node')+edge(id,'M650 443 H700')+node(700,535,285,'Figma bundle','figma-export/ · built from the preview','page-node')+edge(id,'M842 476 V535')+
 label(500,637,'Sequential, resumable state machine · no enabled component-building or publishing branch','edge-label'));
}
export function workflowGraph(mode){
 const id=mode;const selected=mode==='selected-sections';
 let b=node(340,15,320,selected?'Selected sections request':'Full page request','Audit Run ID or Run Name + mode','accent-node');
 const stages=[
 ['R1','Resolve & Load','Validate Fix Plan; load audit and DS'],
 ['R2','Capture Original','Read-only page, frozen once'],
 ['C2','Element Mapping','Locate findings; stamp stable targets'],
 ['scope','Resolve scope',selected?'Complete sections containing Fix findings':'Every page-specific content section'],
 ['B1','Capture Behavior','Record original interactions before edits'],
 ['RV','Resolver','Turn every gap into a target or a preserve'],
 ['R3','Redesign Planner','Apply resolved targets; nothing else'],
 ['R4','Apply & Render','Guard edits; apply in captured browser'],
 ['R5','Compare & Validate','Measure fixes; check structure + visuals'],
 ['R6','Component Review','Build review manifest; no component creation'],
 ['R7','Assemble Output','Reference snapshots + review artifacts'],
 ['R8','React Preview','Generate → build → serve → verify'],
 ['G2','Human Approval','You review the preview and its evidence'],
 ];
 stages.forEach(([n,t,s],i)=>{
   const y=125+i*120;
   b+=edge(id,`M500 ${i===0?81:y-54} V${y}`)+node(310,y,380,(n==='scope'?'':n+' · ')+t,s,n==='G2'?'gate-node':n==='scope'?'accent-node':'',n);
 });
 // R3 sits at y=845 (box 845-911); R5 at y=1085; R8 at y=1445.
 // Pass limit: R5 returns to R3 with open findings; the limit in this setup is one pass.
 b+=edge(id,'M690 1118 H955 V890 H690',true)+label(822,985,'Not PASS + passes remain','edge-label')+
 label(822,1010,'Return to R3 with open findings')+label(822,1035,'Pass limit here: 1 (config)');
 // After R8 the ONE correction budget decides: measured defects go back to R3, then R6 → R8 again.
 b+=edge(id,'M690 1478 H985 V858 H690',true)+label(835,1280,'R8 defect → R3 re-plan, then re-check','edge-label')+
 label(835,1305,'One shared budget: 2 cycles, 3 checks, 15 min');
 b+=label(500,1740,'Budget spent or no progress → report the open items; never pass them','edge-label');
 // Optional mapping conflict gate returns to the same scope boundary.
 b+=node(15,485,250,'G1 · If needed','Mapping / expectation conflicts','gate-node')+
 edge(id,'M310 510 H265',true)+edge(id,'M140 551 V580 H345 V551',true)+
 label(150,609,'No conflict: continue automatically');
 // Judgment side panel; connected at the first judgment stage (C2).
 b+=node(715,365,270,'Judgment','Read bundle → answer → submit','page-node')+
 edge(id,'M690 390 H715',true)+edge(id,'M850 431 V455 H650 V431',true)+
 label(848,490,'C2, RV, R3 and R5 answer here;')+label(848,515,'automatic when deterministic mode is on.')+
 '<g class="diagram-node page-node"><rect x="8" y="827" width="267" height="210" rx="8"/></g>'+
 label(140,858,'Shared DS registry')+label(140,883,'Expected tokens and components')+
 label(130,922,'Persistent redesign rules')+label(130,947,'Shared + project style rules')+
 label(130,986,'Saved run state')+label(130,1011,'Judgments, decisions, budget')+
 edge(id,'M275 907 H310',true)+
 label(835,1560,'R8 checks the running React output.')+label(835,1585,'Failures and missing behavior stay visible.')+
 label(500,1690,'Header and footer are excluded in both modes. Only selected Fix findings authorize changes.','edge-label');
 return box(id,selected?'Selected sections · Complete workflow':'Full page · Complete workflow','R1 through R8 with the Resolver (RV), C2 mapping, B1 behavior capture, the bounded passes, the single correction budget, judgments and human gates.',1760,b);
}
