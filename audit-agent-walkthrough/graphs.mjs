// Static, accessible diagrams. The edges reflect page-graph.ts and site-graph.ts.
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const agents = [
  ['B1', 'Page Analyzer', 'Identify page sections'],
  ['B2', 'Component Detector', 'Detect elements + capture evidence'],
  ['B3', 'DS Matcher', 'Partition matched / unmatched items'],
  ['B4', 'Compliance Auditor', 'Compare matched items with DS rules'],
  ['B5', 'Visual Verifier', 'Verify evidence and findings'],
  ['B6', 'New Component Evaluator', 'Evaluate unmatched items'],
  ['B7', 'Final Coverage & QA', 'Account for every discovered item'],
];
function text(x, y, value, cls = 'workflow-note', anchor = 'middle') {
  return `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${escape(value)}</text>`;
}
function node(x, y, w, h, title, subtitle, cls = '', attrs = '') {
  return `<g class="diagram-node ${cls}" ${attrs}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>${text(x+w/2,y+25,title,'diagram-title')}${subtitle ? text(x+w/2,y+46,subtitle,'diagram-sub') : ''}</g>`;
}
function edge(id, path, dashed = false, arrow = true) {
  return `<path class="diagram-edge${dashed ? ' recovery-edge' : ''}" d="${path}"${arrow ? ` marker-end="url(#${id}-arrow)"` : ''}/>`;
}
function figure(id, title, description, height, body) {
  return `<figure class="panel graph-panel" id="${id}-graph-view" hidden>
    <figcaption><h3>${title}</h3><p class="small muted">${description}</p></figcaption>
    <div class="diagram-scroll" tabindex="0" role="region" aria-label="${title}; scroll horizontally on narrow screens">
    <svg class="execution-diagram" viewBox="0 0 1000 ${height}" role="img" aria-labelledby="${id}-title ${id}-desc">
      <title id="${id}-title">${title}</title><desc id="${id}-desc">${description}</desc>
      <defs><marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="var(--semantic-ink-muted)"/></marker></defs>
      ${body}
    </svg></div></figure>`;
}
function setup(id, mode) {
  return node(350,16,300,60,`${mode} request`,'URL + run name + configured DS') +
    edge(id,'M500 76 V120') +
    node(350,120,300,76,'CLI · Initialize run','Load shared DS, rules and saved state','accent-node') +
    node(20,98,285,130,'D2 · Shared DS registry','D1 · Filesystem reader','page-node') +
    text(162.5,165,'D3 · Tokens     D4 · Components') +
    text(162.5,188,'D5 · Rules        D6 · Version') +
    text(162.5,211,'One snapshot per run') +
    node(695,98,285,130,'Shared runtime logic','S0 · Results    S3 · Taxonomy','page-node') +
    text(837.5,165,'S5 · Classification    S7 · History') +
    text(837.5,188,'S8 · Confidence    S9 · Governance') +
    text(837.5,211,'SQLite state + reusable rules') +
    edge(id,'M305 158 H350',true) + edge(id,'M695 158 H650',true);
}
function reports(id, startY) {
  // The CLI invokes these output modules; they are not B-graph scheduler nodes.
  return node(350,startY,300,60,'C2 · JSON Writer','Canonical audit data + saved findings') +
    edge(id,`M500 ${startY+60} V${startY+91} H220 V${startY+125}`) +
    edge(id,`M500 ${startY+91} H780 V${startY+125}`) +
    node(70,startY+125,300,66,'C1 · HTML Reporter','Standalone report for review') +
    node(630,startY+125,300,66,'Figma preparation','Board plan + operations') +
    edge(id,`M780 ${startY+191} V${startY+230}`) +
    node(630,startY+230,300,66,'Live publication + verification','Verified board link when complete','gate-node') +
    text(255,startY+255,'Reporting modules are invoked by the CLI.') +
    text(255,startY+278,'A local Figma plan is not a published board.');
}
function singlePage() {
  const id = 'page';
  let body = setup(id,'Single page') + edge(id,'M500 196 V270') +
    node(330,270,340,60,'T-layer · Browser capture','Live DOM, computed styles and screenshots','accent-node') +
    edge(id,'M500 330 V380');
  agents.forEach(([code,name,role],i) => {
    const y = 380+i*90;
    body += node(330,y,340,60,`${code} · ${name}`,role,'',`data-graph="${code}" data-agent="${code}"`);
    if(i<6) body += edge(id,`M500 ${y+60} V${y+90}`);
  });
  body += text(155,570,'One live page session') + text(155,595,'Evidence stays available') +
    text(155,620,'through all seven stages.') +
    text(835,585,'B3 splits the data:') + text(835,610,'matched → B4 / B5') +
    text(835,635,'unmatched → B6') + text(835,660,'The agents run sequentially.') +
    node(715,898,270,104,'B7 · Targeted recovery','B2 / B3 / B4 / B6 helpers','page-node') +
    text(850,973,'Bounded attempts; rebuild manifest') +
    edge(id,'M670 940 H715',true) +
    edge(id,'M850 1002 V1020 H610 V980',true) +
    edge(id,'M500 980 V1060') +
    node(330,1060,340,66,'Assemble page result','Coverage, reasons, history and findings','accent-node') +
    edge(id,'M500 1126 V1180') + reports(id,1180);
  return figure(id,'Single page · Complete workflow','Follow one URL through capture, all seven page agents, coverage recovery and report generation.',1510,body);
}
function fullSite() {
  const id = 'site';
  let body = setup(id,'Full site') + edge(id,'M500 196 V253 H165 V280') +
    node(20,280,290,64,'A1 · Site Mapper','Discover and canonicalize URLs') +
    edge(id,'M310 312 H355') +
    node(355,280,290,64,'A2 · Template Classifier','Group page families + propose scope') +
    edge(id,'M645 312 H690') +
    node(690,280,290,64,'Scope approval','Confirm pages before dispatch','gate-node') +
    edge(id,'M835 344 V377 H500 V410') +
    node(350,410,300,64,'A3 · Audit Dispatcher','Skip completed pages; queue the rest','accent-node') +
    edge(id,'M500 474 V520',false,false) +
    text(500,507,'FAN-OUT · Up to 3 concurrent page contexts by default','edge-label');
  [20,350,680].forEach((x,i) => {
    const cx=x+150;
    body += edge(id,`M500 520 H${cx} V548`) +
      `<g class="page-worker" data-worker="${i+1}"><rect class="worker-boundary" x="${x}" y="548" width="300" height="842" rx="12"/>` +
      text(cx,576,`Page worker ${i<2 ? i+1 : 'N'}`,'diagram-title') +
      node(x+24,600,252,58,'T-layer · Capture','DOM + styles + evidence','page-node worker-agent') +
      edge(id,`M${cx} 658 V678`);
    agents.forEach(([code,name,role],j) => {
      const y=678+j*80;
      body += node(x+24,y,252,58,`${code} · ${name}`,role,'worker-agent',`data-agent="${code}"`);
      if(j<6) body += edge(id,`M${cx} ${y+58} V${y+80}`);
    });
    body += edge(id,`M${cx} 1216 V1240`,true) +
      node(x+24,1240,252,54,'B7 · Recovery helpers','B2 / B3 / B4 / B6 · bounded','worker-agent') +
      edge(id,`M${x+24} 1267 H${x+10} V1187 H${x+24}`,true) +
      edge(id,`M${x+276} 1187 H${x+289} V1347 H${x+276}`) +
      node(x+24,1320,252,54,'Page result','Persist outcome + coverage','worker-agent') +
      '</g>' + edge(id,`M${cx} 1374 V1430 H500`,false,false);
  });
  body += text(500,1420,'FAN-IN · Wait until completed + failed = dispatched','edge-label') +
    edge(id,'M500 1430 V1480') +
    node(340,1480,320,64,'A4 · Site Consolidator','Merge results, failures and shared issues','accent-node') +
    edge(id,'M500 1544 V1600') +
    node(350,1600,300,64,'Publish approval','Persist consolidated results, then review','gate-node') +
    edge(id,'M500 1664 V1720') + reports(id,1720);
  return figure(id,'Full site · Complete workflow','Discover pages, approve scope, run the full B1–B7 pipeline in each worker, merge outcomes and prepare reports. Workers reuse the shared DS snapshot; eligible unchanged pages can reuse verified results after capture.',2050,body);
}
export const pageGraph = singlePage();
export const siteGraph = fullSite();
