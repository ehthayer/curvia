/* Smoke test: drives the profile-manager + structured editor in headless Chromium
   (offline / sim fallback — no creds, no network). Serves over http so localStorage
   behaves. Offline, the editor saves a local custom (the live device path is in
   live_test.mjs). */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const server = createServer(async (req, res) => {
  const html = await readFile(new URL('./index.html', import.meta.url));
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise(r => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };

await page.goto(url);
await page.waitForTimeout(300);

// 1. manager renders
check('editor hidden on load', !(await page.locator('#editorModal').isVisible()));
check('manager visible', await page.locator('.manager').isVisible());
check('folders rendered', (await page.locator('.folder').count()) >= 4);
check('profile list rendered', (await page.locator('.pitem').count()) > 0);
check('detail curve canvas present', await page.locator('#detailCurve').isVisible());
await page.screenshot({ path: 'shots/dashboard.png' });

// 2. folder filter + search narrow the list
const allCount = await page.locator('.pitem').count();
await page.locator('.folder', { hasText: 'Custom' }).click();
await page.waitForTimeout(100);
check('Custom folder filters list', (await page.locator('.pitem').count()) <= allCount);
await page.locator('.folder', { hasText: 'All' }).click();
await page.fill('#search', 'zzz-no-match');
await page.waitForTimeout(100);
check('search with no match empties list', (await page.locator('.pitem').count()) === 0);
await page.fill('#search', '');
await page.waitForTimeout(100);

// 3. open editor (+ New) → structured form
await page.click('#newProfileBtn');
check('editor opens on + New', await page.locator('#editorModal').isVisible());
check('editor has live curve canvas', await page.locator('#editorCurve').isVisible());
check('editor seeds one infusion stage', (await page.locator('.ed-stage').count()) === 1);

// 4. edit fields + add a stage
await page.fill('#edName', 'Playwright Test');
await page.fill('#edTemp', '90');
await page.click('#edAddStage');
check('add stage appends a row', (await page.locator('.ed-stage').count()) === 2);

// 5. save → offline saves a local custom
await page.click('#edSave');
check('editor closed after save', !(await page.locator('#editorModal').isVisible()));
const saved = page.locator('.pitem', { hasText: 'Playwright Test' });
check('saved profile in list', (await saved.count()) === 1);
check('saved profile is selected', await saved.evaluate(el => el.classList.contains('sel')));
check('detail shows saved profile', (await page.locator('#detail .dtitle').textContent()).includes('Playwright Test'));
check('detail shows edited temp (90)', (await page.locator('#detail').textContent()).includes('90'));

// 6. persists across reload
await page.reload();
await page.waitForTimeout(300);
check('custom profile survives reload', (await page.locator('.pitem', { hasText: 'Playwright Test' }).count()) === 1);

// 7. select → edit from detail → delete
await page.locator('.pitem', { hasText: 'Playwright Test' }).click();
await page.screenshot({ path: 'shots/manager.png' });
await page.click('#editBtn');
check('edit opens editor prefilled', (await page.inputValue('#edName')) === 'Playwright Test');
await page.screenshot({ path: 'shots/editor.png' });
await page.click('#edDelete');
check('deleted profile removed', (await page.locator('.pitem', { hasText: 'Playwright Test' }).count()) === 0);

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
