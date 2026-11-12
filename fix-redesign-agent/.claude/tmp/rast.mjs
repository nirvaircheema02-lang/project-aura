import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const A = process.argv[2];
const svg = readFileSync(A + '/2ace8e4e9e45.svg', 'utf8');
const b = await chromium.launch(); const p = await b.newPage({ deviceScaleFactor: 3, viewport: { width: 160, height: 176 } });
await p.setContent('<body style="margin:0;background:transparent"><div id=s style="width:154px;height:168px">' + svg + '</div></body>');
await p.locator('#s').screenshot({ path: '.claude/tmp/figassets/2ace8e4e9e45.png', omitBackground: true });
await b.close();
