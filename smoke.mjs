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

// 7. clone from detail → editor opens as a NEW copy → save adds, original untouched
await page.locator('.pitem', { hasText: 'Playwright Test' }).click();
await page.click('#cloneBtn');
check('clone opens editor', await page.locator('#editorModal').isVisible());
check('clone editor titled "Clone profile"', (await page.locator('#editorTitle').textContent()) === 'Clone profile');
check('clone prefills name with (copy)', (await page.inputValue('#edName')) === 'Playwright Test (copy)');
await page.fill('#edName', 'Cloned Shot');
await page.click('#edSave');
check('cloned profile in list', (await page.locator('.pitem', { hasText: 'Cloned Shot' }).count()) === 1);
check('original survives clone', (await page.locator('.pitem', { hasText: 'Playwright Test' }).count()) === 1);
await page.click('#deleteBtn'); await page.click('#deleteBtn');   // clone is selected after save; clean it up
check('clone cleanup deleted', (await page.locator('.pitem', { hasText: 'Cloned Shot' }).count()) === 0);

// 8. select → delete from detail (two-step: first click arms, second deletes)
await page.locator('.pitem', { hasText: 'Playwright Test' }).click();
await page.screenshot({ path: 'shots/manager.png' });
await page.click('#editBtn');
check('edit opens editor prefilled', (await page.inputValue('#edName')) === 'Playwright Test');
check('editor has no delete (lives on the detail view)', (await page.locator('#edDelete').count()) === 0);
await page.screenshot({ path: 'shots/editor.png' });
await page.click('#edCancel');
await page.click('#deleteBtn');
check('first delete click arms confirmation', (await page.locator('#deleteBtn').textContent()) === 'Confirm delete');
check('profile not deleted before confirm', (await page.locator('.pitem', { hasText: 'Playwright Test' }).count()) === 1);
await page.click('#deleteBtn');
check('deleted profile removed', (await page.locator('.pitem', { hasText: 'Playwright Test' }).count()) === 0);
await page.locator('.pitem').first().click();       // first item is a built-in (Classic 9-bar)
check('built-in detail has no delete', (await page.locator('#deleteBtn').count()) === 0);

// 9. export downloads a JSON backup
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
const fname = download.suggestedFilename();
check('export downloads a JSON backup', fname.startsWith('curvia-profiles-') && fname.endsWith('.json'));

// 10. empty folder shows the empty detail state, not a stale profile from another folder
await page.locator('.folder', { hasText: 'Built-in' }).click();
await page.locator('.pitem').first().click();
await page.locator('.folder', { hasText: 'Custom' }).click();
await page.waitForTimeout(100);
while (await page.locator('.pitem').count()) {            // empty the Custom folder
  await page.locator('.pitem').first().click();
  await page.click('#deleteBtn'); await page.click('#deleteBtn');
  await page.waitForTimeout(100);
}
await page.locator('.folder', { hasText: 'Built-in' }).click();
await page.locator('.folder', { hasText: 'Custom' }).click();
await page.waitForTimeout(100);
check('empty folder shows empty detail (no stale profile)',
  (await page.locator('#detail').textContent()).includes('Select a profile'));
await page.locator('.folder', { hasText: 'All' }).click();   // no-match search hits the same path
await page.fill('#search', 'zzz-no-match');
await page.waitForTimeout(100);
check('no-match search shows empty detail',
  (await page.locator('#detail').textContent()).includes('Select a profile'));

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
