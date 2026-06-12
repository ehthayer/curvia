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

// 4b. Eureka dial ⇄ grind packing (R.MMmm: rev counter + zero-padded mark)
await page.fill('#edRev', '0');
await page.fill('#edMark', '19.75');
check('eureka rev 0 mark 19.75 packs to 0.1975', (await page.inputValue('#edGrind')) === '0.1975');
await page.fill('#edGrind', '1.054');
check('grind 1.054 unpacks to rev 1', (await page.inputValue('#edRev')) === '1');
check('grind 1.054 unpacks to mark 5.4', (await page.inputValue('#edMark')) === '5.4');
await page.fill('#edGrind', '1.7');
check('non-eureka grind (mark 70) blanks the dial', (await page.inputValue('#edRev')) === '' && (await page.inputValue('#edMark')) === '');
await page.fill('#edGrind', '2');
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

// 9b. Share button present; offline (no live device customs) it guides rather than firing a write
check('share button present', (await page.locator('#shareBtn').count()) === 1);
await page.locator('.folder', { hasText: 'Built-in' }).click();
await page.locator('.pitem').first().click();      // a built-in is not shareable
await page.click('#shareBtn');
await page.waitForTimeout(150);
const guardToast = await page.locator('#toast').evaluate(el => ({ shown: el.classList.contains('show'), text: el.textContent }));
check('share guard shows a toast', guardToast.shown && /your own custom/i.test(guardToast.text), guardToast.text);
await page.waitForTimeout(2900);
check('toast auto-dismisses', !(await page.locator('#toast').evaluate(el => el.classList.contains('show'))));
await page.locator('.folder', { hasText: 'All' }).click();

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

// 11. deleted customs stay deleted across reload (no demo profile re-seeded)
await page.reload();
await page.waitForTimeout(300);
await page.locator('.folder', { hasText: 'Custom' }).click();
await page.waitForTimeout(100);
check('deleted customs stay gone after reload', (await page.locator('.pitem').count()) === 0);

// 12. Roasters mode (offline): hint, then a graceful needs-live message — never a crash
await page.locator('.folder', { hasText: 'Roasters' }).click();
await page.waitForTimeout(100);
check('roasters folder shows search hint', (await page.locator('#profiles').innerText()).includes('Type a roaster name'));
check('roasters empty detail', (await page.locator('#detail').innerText()).includes('Select a profile'));
await page.fill('#search', 'sey');
await page.waitForTimeout(700);                            // debounce (300ms) + fetch
check('offline roaster search reports needs-live', (await page.locator('#profiles').innerText()).includes('live connection'));
await page.fill('#search', '');
await page.locator('.folder', { hasText: 'All' }).click();
await page.waitForTimeout(100);
check('leaving roasters restores the list', (await page.locator('.pitem').count()) > 0);

// 13. Shared folder (offline): import row renders; bad input + offline resolve fail gracefully
await page.locator('.folder', { hasText: 'Shared' }).click();
await page.waitForTimeout(100);
check('shared folder shows import row', await page.locator('#shareLinkInput').isVisible());
check('shared folder empty hint', (await page.locator('#profiles').innerText()).includes('No shared imports yet'));
await page.fill('#shareLinkInput', 'not a link!!');
await page.click('#importShareBtn');
await page.waitForTimeout(100);
check('bad share link rejected', (await page.locator('#dataSrc').innerText()).includes('not a brew.link'));
await page.fill('#shareLinkInput', 'https://brew.link/p/AbCdEf1234/espresso');
await page.click('#importShareBtn');
await page.waitForTimeout(500);
check('offline import fails gracefully', (await page.locator('#dataSrc').innerText()).includes('import failed'));
check('no shared item added on failure', (await page.locator('.pitem').count()) === 0);

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
