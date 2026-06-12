/* Live end-to-end Playwright test: drives the profile-manager against server.mjs
   with REAL Fellow Series 1 data (creds from .env). Asserts the live wiring +
   folder/search/detail flow; saves screenshots to shots/.
   Run:  node live_test.mjs   (needs .env with FELLOW_EMAIL/FELLOW_PASSWORD) */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 8092;
const base = `http://localhost:${PORT}`;
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!ok) failures++; };

// start the server (uses its own .env loader)
const srv = spawn('node', ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvlog = '';
srv.stdout.on('data', d => (srvlog += d));
srv.stderr.on('data', d => (srvlog += d));
await new Promise((res, rej) => {
  const t = setInterval(() => { if (/Fellow mockup/.test(srvlog)) { clearInterval(t); res(); } }, 100);
  setTimeout(() => { clearInterval(t); rej(new Error('server did not start:\n' + srvlog)); }, 8000);
});
check('server started in LIVE mode', /LIVE/.test(srvlog), srvlog.trim());

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('dataSrc')?.textContent?.startsWith('live'), { timeout: 8000 }).catch(() => {});
  const dataSrc = await page.$eval('#dataSrc', e => e.textContent);
  check('footer shows live profiles', /^live · \d+ profiles/.test(dataSrc), dataSrc);

  const conn = await page.$eval('#connLabel', e => e.textContent);
  check('header shows real connection + firmware', /fw \d/.test(conn), conn);

  const names = await page.$$eval('.pitem .pname', els => els.map(e => e.textContent.replace('★', '').trim()));
  check('real profiles rendered (>3)', names.length > 3, `${names.length}: ${names.slice(0, 3).join(', ')}…`);

  // folder filter: Drops shows a subset
  const allCount = names.length;
  await page.locator('.folder', { hasText: 'Drops' }).click();
  await page.waitForTimeout(150);
  const dropsCount = await page.locator('.pitem').count();
  check('Drops folder filters the list', dropsCount > 0 && dropsCount <= allCount, `${dropsCount}/${allCount}`);
  await page.locator('.folder', { hasText: 'All' }).click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: 'shots/live-manager.png' });

  // select a specific real profile → detail shows its params + curve
  const target = 'Costa Rica La Guaca';   // no-PI, two-stage 9→8 bar, 94C, x2
  const idx = names.indexOf(target);
  if (idx >= 0) {
    await page.$$('.pitem').then(els => els[idx].click());
    await page.waitForTimeout(150);
    const title = await page.$eval('#detail .dtitle', e => e.textContent.trim());
    check('detail title matches selection', title.includes(target), title);
    const detail = (await page.$eval('#detail', e => e.textContent)).replace(/\s+/g, ' ');
    check('detail shows real params (94°C / 36g yield)', /94\s*°C/.test(detail) && /36\s*g/.test(detail), detail.slice(0, 90));
    const selName = await page.$eval('.pitem.sel .pname', e => e.textContent.replace('★', '').trim()).catch(() => '');
    check('selected item highlighted', selName === target, selName);
    check('Drops profile is not deletable (no delete button)', (await page.locator('#deleteBtn').count()) === 0);
    await page.screenshot({ path: 'shots/live-detail.png' });
  } else {
    check(`found "${target}" in list`, false, `have: ${names.join(', ')}`);
  }

  // Set Active wiring — verify the button renders; do NOT click (would mutate the real device).
  check('Set Active button wired for a non-active profile', (await page.locator('#setActiveBtn').count()) === 1);
  const starItem = page.locator('.pitem', { has: page.locator('.star') }).first();
  if (await starItem.count()) {
    await starItem.click();
    await page.waitForTimeout(120);
    check('active profile shows "Active on machine"', (await page.$eval('#detail', e => e.textContent)).includes('Active on machine'));
  }

  // Roasters mode — read-only search of the global customs catalog.
  // Results are other users' profiles: clone must be the ONLY action offered.
  await page.locator('.folder', { hasText: 'Roasters' }).click();
  await page.fill('#search', 'sey');
  await page.waitForTimeout(4000);                  // debounce + first catalog fetch (~5k records)
  const roasterCount = await page.locator('.pitem').count();
  check('roaster search "sey" returns catalog results', roasterCount > 0, String(roasterCount));
  if (roasterCount) {
    await page.locator('.pitem').first().click();
    await page.waitForTimeout(150);
    check('catalog detail is clone-only (no edit/delete/set-active)',
      (await page.locator('#cloneBtn').count()) === 1 &&
      (await page.locator('#editBtn').count()) === 0 &&
      (await page.locator('#deleteBtn').count()) === 0 &&
      (await page.locator('#setActiveBtn').count()) === 0);
    await page.screenshot({ path: 'shots/live-roasters.png' });
  }
  await page.fill('#search', '');
  await page.locator('.folder', { hasText: 'All' }).click();
  await page.waitForTimeout(150);

  // Shared imports — resolve a real brew.link code (public endpoint, read-only) and
  // verify the local copy is clone-only against the device but locally deletable.
  // NOTE: depends on this share link staying live; re-share any profile to replace it.
  const SHARE_CODE = '5kM9Qv2nkB';
  await page.locator('.folder', { hasText: 'Shared' }).click();
  await page.fill('#shareLinkInput', `https://brew.link/p/${SHARE_CODE}/espresso`);
  await page.click('#importShareBtn');
  await page.waitForTimeout(2500);
  const imported = await page.locator('.pitem').count();
  check('brew.link import resolves', imported === 1, await page.$eval('#dataSrc', e => e.textContent));
  if (imported) {
    check('shared detail marks brew.link provenance', /brew\.link/i.test(await page.locator('.dsub').innerText()));
    check('shared import is clone-only vs device (no edit/set-active)',
      (await page.locator('#cloneBtn').count()) === 1 &&
      (await page.locator('#editBtn').count()) === 0 &&
      (await page.locator('#setActiveBtn').count()) === 0);
    await page.screenshot({ path: 'shots/live-shared.png' });
    await page.click('#deleteBtn'); await page.click('#deleteBtn');   // local delete only — cleans up
    await page.waitForTimeout(150);
    check('shared import locally deletable', (await page.locator('.pitem').count()) === 0);
  }
  await page.locator('.folder', { hasText: 'All' }).click();
  await page.waitForTimeout(150);

  check('no JS page errors', pageErrors.length === 0, pageErrors.join('; '));
} finally {
  await browser.close();
  srv.kill();
}

console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'all live checks passed'}`);
process.exit(failures ? 1 : 0);
