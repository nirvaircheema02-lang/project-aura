const { chromium } = require('../audit-agent/node_modules/playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const shots = process.env.SHOT_DIR || '/private/tmp'; // screenshots: set SHOT_DIR to keep them out of /private/tmp
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, offline: true });
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => { if (/^https?:/.test(req.url())) requests.push(req.url()); });
  await page.goto(pathToFileURL(path.join(__dirname, 'dist/index.html')).href);
  await page.waitForSelector('#purpose:not([hidden])');
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('16px "DM Sans"')), true);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.match(await page.locator('.brand').innerText(), /^A\s*Audit Agent/);
  assert.doesNotMatch(await page.title(), /Project Aura/);
  // The revision, date and saved run printed in the guide come from the code at build time, never from typed-in text.
  const engineRev = await page.evaluate(() => D.engineRevision);
  assert.match(await page.locator('.sidebar .footnote').innerText(), new RegExp(`Engine revision ${engineRev}\\b`));
  assert.match(await page.locator('#whats-new').innerText(), /Revisions 10, 11 and 12/);
  assert.match(await page.locator('#whats-new').innerText(), new RegExp(`engine revision ${engineRev}`));
  assert.doesNotMatch(await page.locator('#whats-new').innerText(), /\{\{/);
  await page.evaluate(() => showChapter('start', false));
  await page.selectOption('#start-mode', 'full-site');
  await page.locator('#start-url').fill('https://www.kenresearch.com/');
  await page.locator('#start-name').fill("Ken's Site Audit v1");
  assert.match(await page.locator('#start-prompt').innerText(), /Mode: full-site/);
  assert.match(await page.locator('#start-command').textContent(), /pnpm audit-site/);
  // Apostrophes in the run name must not break the generated shell command.
  assert.ok((await page.locator('#start-command').textContent()).includes("'Ken'\\''s Site Audit v1'"));
  await page.locator('#start-url').fill('javascript:alert(1)');
  assert.equal(await page.locator('#copy-start').isDisabled(), true);
  assert.equal(await page.locator('#start-command').textContent(), '');
  await page.selectOption('#start-mode', 'single-page');
  await page.locator('#start-url').fill('https://www.kenresearch.com/survey/sustainable-product-consumer-perception-survey');
  await page.locator('#start-name').fill('Sustainable Survey Audit v1');
  assert.match(await page.locator('#start-command').textContent(), /pnpm audit-page/);
  await page.locator('#copy-start').click();
  // The clipboard write is asynchronous (it fell back to "selected" only after the click handler returned) — wait for the status instead of racing it.
  await page.waitForFunction(() => /copied|selected/.test(document.querySelector('#copy-status').innerText), null, { timeout: 5000 });
  assert.match(await page.locator('#copy-status').innerText(), /copied|selected/);
  await page.screenshot({ path: `${shots}/audit-agent-start.png`, fullPage: true });
  await page.evaluate(() => showChapter('architecture', false));
  const agentCount = await page.locator('#agent-count').innerText();
  assert.match(agentCount, /11 pipeline agents/);
  assert.match(agentCount, /A1–A4/);
  assert.match(agentCount, /B1–B7/);
  assert.match(agentCount, /C1–C4/);
  assert.match(agentCount, /D1–D6/);
  assert.deepEqual(await page.locator('[data-graph-view]').allTextContents(), ['System overview', 'Single page', 'Full site']);
  const typography = await page.locator('#architecture h1').evaluate(el => ({ size: parseFloat(getComputedStyle(el).fontSize), font: getComputedStyle(el).fontFamily }));
  assert.ok(typography.size <= 31.3);
  assert.match(typography.font, /DM Sans/);
  assert.equal(await page.locator('#system-graph-view:visible').count(), 1);
  await page.selectOption('#worker-count', '1');
  assert.equal(await page.locator('.queue-batch').count(), 6);
  await page.selectOption('#worker-count', '3');
  assert.equal(await page.locator('.queue-batch').count(), 2);
  assert.equal(await page.locator('.queue-batch span').count(), 6);
  await page.locator('[data-graph-view="site"]').click();
  assert.equal(await page.locator('#site-graph-view:visible').count(), 1);
  assert.match(await page.locator('#site-graph-view').textContent(), /FAN-OUT/);
  assert.match(await page.locator('#site-graph-view').textContent(), /FAN-IN/);
  assert.equal(await page.locator('#site-graph-view .page-worker').count(), 3);
  assert.equal(await page.locator('#site-graph-view [data-agent]').count(), 21);
  await page.evaluate(() => { window.getSelection().removeAllRanges(); window.scrollTo(0,0); });
  await page.screenshot({ path: `${shots}/audit-agent-fanout-graph.png`, fullPage: true });
  await page.locator('[data-graph-view="page"]').click();
  assert.equal(await page.locator('#page-graph-view:visible').count(), 1);
  assert.equal(await page.locator('#page-graph-view [data-agent]').count(), 7);
  assert.equal(await page.locator('#page-graph-view .recovery-edge').count(), 4);
  for (const view of ['system', 'page', 'site']) {
    await page.locator(`[data-graph-view="${view}"]`).click();
    const clipped = await page.locator(`#${view}-graph-view .diagram-node`).evaluateAll(nodes => nodes.flatMap(node => {
      const rect = node.querySelector('rect').getBBox();
      return [...node.querySelectorAll('text')].filter(text => {
        const box = text.getBBox();
        return box.x < rect.x + 4 || box.x + box.width > rect.x + rect.width - 4;
      }).map(text => text.textContent);
    }));
    assert.deepEqual(clipped, [], `${view}: node labels must fit their boxes`);
  }
  await page.locator('details').filter({ has: page.locator('[data-loop="property"]') }).locator('summary').click();
  await page.locator('[data-loop="property"]').click();
  assert.equal(await page.locator('[data-graph].active').count(), 2);
  assert.match(await page.locator('#loop-detail').innerText(), /B7 → B4 → B7/);
  await page.locator('[data-loop="unresolved"]').click();
  assert.equal(await page.locator('[data-graph].active').count(), 1);
  assert.match(await page.locator('#loop-detail').innerText(), /Capture Failed/);
  await page.locator('[data-loop="missing"]').click();
  await page.evaluate(() => window.scrollTo(0,0));
  await page.screenshot({ path: `${shots}/audit-agent-graph.png`, fullPage: true });
  await page.evaluate(() => showChapter('outputs', false));
  assert.equal(await page.locator('#outputs .output-card').count(), 2);
  assert.doesNotMatch(await page.locator('#outputs').innerText(), /Excel|XLSX|\.xlsx/);
  await page.evaluate(() => showChapter('boundaries', false));
  assert.equal(await page.locator('#next-chapter').innerText(), 'Back to overview');
  await page.locator('#next-chapter').click();
  assert.equal(await page.locator('.chapter:visible').getAttribute('id'), 'purpose');
  await page.screenshot({ path: `${shots}/aura-guide-desktop.png`, fullPage: true });
  const ids = await page.locator('.chapter').evaluateAll(els => els.map(e => e.id));
  const overflow = [];
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const id of ids) {
      await page.evaluate(id => showChapter(id, false), id);
      const size = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      if (size.sw > size.cw + 1) overflow.push({ width, id, ...size });
      assert.equal(await page.locator('.chapter:visible').count(), 1);
      assert.equal(await page.locator('.chapter:visible').getAttribute('id'), id);
      const badImages = await page.locator('.chapter:visible img').evaluateAll(els => els.filter(e => !e.complete || !e.naturalWidth).map(e => e.alt));
      assert.deepEqual(badImages, [], `Images: ${id}`);
      if (id === 'architecture') {
        for (const view of ['system', 'site', 'page']) {
          await page.locator(`[data-graph-view="${view}"]`).click();
          const graphSize = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
          assert.ok(graphSize.sw <= graphSize.cw + 1, `${view} graph overflow at ${width}`);
        }
      }
      const copy = await page.locator('.chapter:visible').innerText();
      assert.doesNotMatch(copy, /\b(?:hai|hain|karta|karti|karna|karo|mein|nahi|chahiye|samjho|kya|kaise|aur|pehle|toh|karein)\b/i, `English-only copy: ${id}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => showChapter('journey', false));
  for (let i = 0; i < 8; i++) {
    await page.locator(`[data-stage="${i}"]`).click();
    assert.match(await page.locator('#stage-count').innerText(), new RegExp(`${i + 1} / 8`));
  }
  await page.locator('[data-mode="anthropic-api"]').click();
  assert.match(await page.locator('.node-mode').innerText(), /NEEDS_REVIEW/);
  await page.locator('[data-scope="site"]').click();
  assert.equal(await page.locator('#full-site:visible').count(), 1);
  await page.locator('[data-mode="no-api"]').click();
  await page.locator('[data-scope="page"]').click();
  await page.locator('[data-stage="4"]').click();
  await page.screenshot({ path: `${shots}/aura-guide-journey.png`, fullPage: true });
  await page.evaluate(() => showChapter('evidence', false));
  assert.match(await page.locator('#run-source').innerText(), /engine r\d+/);
  assert.doesNotMatch(await page.locator('#run-source').innerText(), /Invalid Date|undefined|NaN/);
  for (let i = 0; i < 3; i++) {
    await page.locator(`[data-example="${i}"]`).click();
    await page.locator('#enlarge-evidence').click();
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await page.keyboard.press('Escape');
    const details = page.locator('#finding-detail details').last();
    await details.locator('summary').click();
    await page.locator('#raw-finding').click();
    assert.match(await page.locator('#dialog-body').innerText(), /findingId/);
    await page.locator('#close-dialog').click();
  }
  await page.locator('[data-example="0"]').click();
  await page.screenshot({ path: `${shots}/aura-guide-evidence.png`, fullPage: true });
  await page.evaluate(() => showChapter('fallback', false));
  for (let i = 0; i < 4; i++) await page.locator(`[data-scenario="${i}"]`).click();
  await page.locator('[data-scenario="1"]').click();
  await page.screenshot({ path: `${shots}/aura-guide-fallback.png`, fullPage: true });
  const sources = await page.evaluate(() => Object.keys(D.sources));
  for (const source of sources) {
    await page.evaluate(source => openSource(source), source);
    assert.ok((await page.locator('#dialog-body pre').innerText()).length > 30);
    await page.keyboard.press('Escape');
  }
  await page.locator('#search').fill('skills');
  await page.locator('#search').press('Enter');
  assert.equal(await page.locator('.chapter:visible').getAttribute('id'), 'skills');
  await page.evaluate(() => showChapter('outputs', false));
  await page.locator('[data-answer="no"]').click();
  assert.match(await page.locator('#quiz-result').innerText(), /Correct/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.selectOption('#mobile-chapter', 'purpose');
  await page.screenshot({ path: `${shots}/aura-guide-mobile.png`, fullPage: true });
  await page.selectOption('#mobile-chapter', 'evidence');
  await page.screenshot({ path: `${shots}/aura-guide-mobile-evidence.png`, fullPage: true });
  // Emulate enlarged text independently of viewport resizing.
  await page.addStyleTag({ content: 'html{font-size:200%} body{font-size:200%}' });
  for (const id of ids) {
    await page.evaluate(id => showChapter(id, false), id);
    const size = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    if (size.sw > size.cw + 1) overflow.push({ width: 390, text: '200%', id, ...size });
  }
  assert.deepEqual(errors, [], 'Browser errors');
  assert.deepEqual(requests, [], 'No external network requests');
  assert.deepEqual(overflow, [], 'Horizontal overflow');
  const report = { passed: true, language: 'en', chapters: ids.length, stages: 8, examples: 3, scenarios: 4, graphViews: ['system', 'site', 'page'], queueDemoCapacities: [1,3], startBuilderModes: ['single-page', 'full-site'], recoveryScenarios: 3, reviewOutputs: ['HTML', 'Figma'], sourceExcerpts: sources.length, viewports: [1440,768,390], offline: true, errors, externalRequests: requests, overflow };
  fs.writeFileSync(path.join(__dirname, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
