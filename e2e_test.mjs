/* Full CRUD end-to-end test against the REAL device, using a disposable "My Test"
   profile that is always deleted (UI delete + API safety-net cleanup).
   Drives the actual app UI (create → edit → delete) and verifies each step against
   the device via the live API. Run: node e2e_test.mjs   (needs .env). */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { getProfiles, deleteProfile } from './fellow-client.mjs';

const PORT = 8094, base = `http://localhost:${PORT}`;
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!ok) failures++; };
const myTest = async () => (await getProfiles()).find(p => p.title === 'My Test');

const srv = spawn('node', ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => (log += d)); srv.stderr.on('data', d => (log += d));
await new Promise((res, rej) => { const t = setInterval(() => { if (/Fellow mockup/.test(log)) { clearInterval(t); res(); } }, 100); setTimeout(() => { clearInterval(t); rej(new Error('server did not start:\n' + log)); }, 8000); });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 980 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));

try {
  const stray = await myTest(); if (stray) { await deleteProfile(stray.id); console.log('(pre-clean) removed stray My Test'); }

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('dataSrc')?.textContent?.startsWith('live'), { timeout: 8000 });

  // ---- CREATE (POST) via the editor ----
  await page.click('#newProfileBtn');
  await page.fill('#edName', 'My Test');
  await page.fill('#edTemp', '91');
  await page.click('#edSave');
  await page.waitForSelector('.pitem:has-text("My Test")', { timeout: 12000 });
  check('CREATE: My Test appears in the list', true);
  let mt = await myTest();
  check('CREATE: exists on device (API)', !!mt, mt && `id=${mt.id}`);
  check('CREATE: temperature persisted = 91', mt?.temperature === 91, String(mt?.temperature));

  // ---- EDIT (PATCH) via the editor ----
  await page.locator('.pitem', { hasText: 'My Test' }).first().click();
  await page.click('#editBtn');
  await page.fill('#edTemp', '88');
  await page.check('#edDeclining');
  await page.fill('#edNotes', 'e2e note');
  await page.click('#edSave');
  await page.waitForTimeout(2800);
  mt = await myTest();
  check('EDIT: temperature -> 88', mt?.temperature === 88, String(mt?.temperature));
  check('EDIT: decliningTemp -> on', mt?.decliningTemp === 'on', String(mt?.decliningTemp));
  check('EDIT: notes -> "e2e note"', mt?.notes === 'e2e note', JSON.stringify(mt?.notes));

  // ---- DELETE from the detail view (two-step: arm, then confirm) ----
  await page.locator('.pitem', { hasText: 'My Test' }).first().click();
  await page.click('#deleteBtn');
  check('DELETE: first click arms confirmation', (await page.locator('#deleteBtn').textContent()) === 'Confirm delete');
  await page.click('#deleteBtn');
  await page.waitForTimeout(2800);
  check('DELETE: gone from list', (await page.locator('.pitem', { hasText: 'My Test' }).count()) === 0);
  check('DELETE: gone from device (API)', !(await myTest()));

  check('no JS page errors', errs.length === 0, errs.join('; '));
} finally {
  try { const s = await myTest(); if (s) { await deleteProfile(s.id); console.log('(cleanup) deleted leftover My Test', s.id); } } catch (e) { console.log('(cleanup) error:', e.message); }
  await browser.close(); srv.kill();
}
console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'all e2e checks passed'}`);
process.exit(failures ? 1 : 0);
