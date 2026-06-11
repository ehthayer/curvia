/* Shared Fellow cloud client for the Series 1 ("Solo") espresso mockup.
 *
 * One copy of the login / token-refresh / device-lookup logic, used by BOTH:
 *   - server.mjs        (browser dev: serves index.html + /api/* over localhost)
 *   - electron-main.cjs (desktop app: same data over IPC, no open port)
 *
 * Credentials stay in this Node process — never sent to the renderer/browser.
 *   FELLOW_EMAIL / FELLOW_PASSWORD via env or the repo-root .env
 * Without creds, getProfiles()/getDevice() throw and the UI falls back to its
 * built-in simulated profiles.
 */
import { readFileSync } from 'node:fs';

// Robust .env loader: parses VALUE verbatim (does NOT treat an unquoted '#' as a
// comment the way `node --env-file` does, which silently truncates passwords).
// Strips one matched surrounding quote pair; trims trailing whitespace otherwise.
// Shell env takes precedence.
function loadDotEnv() {
  try {
    const txt = readFileSync(new URL('./.env', import.meta.url), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;          // blank / full-line comment
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1);                        // rest of line, verbatim
      const q = val.match(/^(['"])([\s\S]*)\1\s*$/);       // matched surrounding quotes?
      val = q ? q[2] : val.replace(/\s+$/, '');            // else trim trailing ws only
      if (!(key in process.env)) process.env[key] = val;   // shell env wins
    }
  } catch { /* no .env — rely on real env vars */ }
}
loadDotEnv();

const HOST = 'https://l8qtmnc692.execute-api.us-west-2.amazonaws.com';
const UA = 'Fellow/5 CFNetwork/1568.300.101 Darwin/24.2.0';
const TIMEOUT_MS = 15_000;   // per request — a stalled connection otherwise hangs the UI forever
// Credentials: seeded from env (.env / CI for dev + the browser server), or set at
// runtime via setCredentials() — the desktop app decrypts them from the OS keychain
// (Electron safeStorage) and calls that. See electron-main.cjs.
let creds = { email: process.env.FELLOW_EMAIL || null, password: process.env.FELLOW_PASSWORD || null };

export function setCredentials(email, password) {
  creds = { email: email || null, password: password || null };
  token = null; soloIdCache = null;            // re-login on next call with the new creds
}
export function hasCredentials() { return Boolean(creds.email && creds.password); }

let token = null;
let soloIdCache = null;

async function login() {
  const r = await fetch(HOST + '/v1/auth/login', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error('login HTTP ' + r.status);
  token = (await r.json()).accessToken;
}

async function api(path) {
  if (!token) await login();
  const opts = () => ({
    headers: { 'User-Agent': UA, Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let r = await fetch(HOST + path, opts());
  if (r.status === 401) { await login(); r = await fetch(HOST + path, opts()); } // token expired
  if (!r.ok) throw new Error(path + ' -> HTTP ' + r.status);
  return r.json();
}

// Cache the in-flight promise (not just the id) so concurrent first calls share
// one device lookup; drop the cache on failure so the next call can retry.
function soloId() {
  return (soloIdCache ??= (async () => {
    const devs = await api('/v2/devices?dataType=real');
    const d = devs.find(x => String(x.id).startsWith('FS_') || x.deviceType === 'Solo');
    if (!d) throw new Error('no Espresso Series 1 (Solo) device on this account');
    return d.id;
  })().catch(err => { soloIdCache = null; throw err; }));
}

async function apiWrite(method, path, body) {
  if (!token) await login();
  const opts = () => ({
    method,
    headers: { 'User-Agent': UA, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let r = await fetch(HOST + path, opts());
  if (r.status === 401) { await login(); r = await fetch(HOST + path, opts()); } // token expired
  const txt = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status} ${txt.slice(0, 200)}`);
  try { return txt ? JSON.parse(txt) : { ok: true, status: r.status }; } // 204 -> {ok}
  catch { return { ok: true, status: r.status }; }
}

function requireCreds() {
  if (!hasCredentials()) throw new Error('not signed in — set FELLOW_EMAIL/PASSWORD or sign in');
}

/** Series 1 espresso profiles (drops + fellow built-ins + device-bound customs). */
export async function getProfiles() {
  requireCreds();
  return api(`/v2/solo/devices/${await soloId()}/profiles`);
}

/** Series 1 device object (connection state, activeProfileId, units, …). */
export async function getDevice() {
  requireCreds();
  return api(`/v2/solo/devices/${await soloId()}`);
}

/** Set the machine's active profile. VERIFIED working: PATCH -> 204, and the
 *  change propagates to the device's physical panel (unlike the brew commands,
 *  which 200 but no-op). Body = {profileId, settingsVersion} (client-clock LWW). */
export async function setActiveProfile(profileId) {
  requireCreds();
  if (!profileId) throw new Error('profileId required');
  await apiWrite('PATCH', `/v2/solo/devices/${await soloId()}/active-profile`,
    { profileId, settingsVersion: Math.floor(Date.now() / 1000) });
  return { ok: true, profileId };
}

/** Create a new profile on the machine (POST). Body = brew-schema DTO (no id).
 *  Verified end-to-end by e2e_test.mjs (create → verify on device → delete). */
export async function createProfile(dto) {
  requireCreds();
  return apiWrite('POST', `/v2/solo/devices/${await soloId()}/profiles`, dto);
}

/** Update an existing device profile (PATCH /profiles/{pid}). Verified working
 *  per FELLOW_API.md (temperature + infusion round-tripped). */
export async function updateProfile(pid, dto) {
  requireCreds();
  if (!pid) throw new Error('profile id required');
  return apiWrite('PATCH', `/v2/solo/devices/${await soloId()}/profiles/${encodeURIComponent(pid)}`, dto);
}

/** Delete a device profile (DELETE /profiles/{pid}). Requires a {settingsVersion}
 *  body (LWW), same as the other writes — verified by e2e_test.mjs. */
export async function deleteProfile(pid) {
  requireCreds();
  if (!pid) throw new Error('profile id required');
  return apiWrite('DELETE', `/v2/solo/devices/${await soloId()}/profiles/${encodeURIComponent(pid)}`,
    { settingsVersion: Math.floor(Date.now() / 1000) });
}
