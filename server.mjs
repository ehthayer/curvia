/* Local dev proxy for the Fellow espresso mockup (browser path).
 *
 * Serves index.html and exposes two read-only JSON endpoints backed by the
 * real Fellow cloud API (see FELLOW_API.md), using the shared client:
 *   GET  /api/profiles       -> Series 1 espresso profiles
 *   GET  /api/device         -> Series 1 device object
 *   GET  /api/roasters?q=…   -> search the global customs catalog by roaster/title/notes (read-only)
 *   POST /api/active-profile -> set active profile {profileId}  (verified write)
 *
 * Credentials stay server-side (never sent to the browser):
 *   FELLOW_EMAIL=you@example.com FELLOW_PASSWORD=… node server.mjs
 * Without creds the page still runs on its built-in simulated profiles.
 *
 * The desktop app (electron-main.cjs) reuses the same fellow-client.mjs over IPC.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { getProfiles, getDevice, setActiveProfile, createProfile, updateProfile, deleteProfile, searchRoasterProfiles, resolveSharedProfile, shareProfile, hasCredentials } from './fellow-client.mjs';

const PORT = process.env.PORT || 8099;

// Local-only hardening: the API drives a real espresso account, so reject anything
// that isn't a same-machine browser talking to localhost.
//  - Host allowlist blocks DNS-rebinding (a remote page pointing its own hostname here).
//  - Requiring JSON content-type on body-carrying writes makes cross-origin fetches
//    non-"simple", so browsers preflight (and fail) them instead of firing the write.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const isJson = req => (req.headers['content-type'] || '').split(';')[0].trim() === 'application/json';

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readJson = req => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', c => (d += c));
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const server = createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
    if (req.url === '/' || req.url === '/index.html') {
      return send(res, 200, await readFile(new URL('./index.html', import.meta.url)), 'text/html');
    }
    if (req.url.startsWith('/api/')) {
      // brew.link resolve is public upstream (no account involved) — allow it credless
      if (req.url.startsWith('/api/shared/') && req.method === 'GET') {
        const code = decodeURIComponent(req.url.slice('/api/shared/'.length));
        return send(res, 200, await resolveSharedProfile(code));
      }
      if (!hasCredentials()) return send(res, 503, { error: 'set FELLOW_EMAIL and FELLOW_PASSWORD env vars' });
      if ((req.method === 'POST' || req.method === 'PATCH') && !isJson(req)) {
        return send(res, 415, { error: 'content-type must be application/json' });
      }
      if (req.url === '/api/profiles' && req.method === 'GET') return send(res, 200, await getProfiles());
      if (req.url === '/api/profiles' && req.method === 'POST') return send(res, 200, await createProfile(await readJson(req)));
      if (req.url.startsWith('/api/profiles/') && req.url.endsWith('/share') && req.method === 'POST') {
        const pid = decodeURIComponent(req.url.slice('/api/profiles/'.length, -'/share'.length));
        return send(res, 201, await shareProfile(pid));   // ⚠ mints a PERMANENT public brew.link
      }
      if (req.url.startsWith('/api/profiles/') && req.method === 'PATCH') {
        const pid = decodeURIComponent(req.url.slice('/api/profiles/'.length));
        return send(res, 200, await updateProfile(pid, await readJson(req)));
      }
      if (req.url.startsWith('/api/profiles/') && req.method === 'DELETE') {
        const pid = decodeURIComponent(req.url.slice('/api/profiles/'.length));
        return send(res, 200, await deleteProfile(pid));
      }
      if (req.url.startsWith('/api/roasters') && req.method === 'GET') {
        const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
        return send(res, 200, await searchRoasterProfiles(q));
      }
      if (req.url === '/api/device') return send(res, 200, await getDevice());
      if (req.url === '/api/active-profile' && req.method === 'POST') {
        const { profileId } = await readJson(req);
        return send(res, 200, await setActiveProfile(profileId));
      }
      return send(res, 404, { error: 'unknown api route' });
    }
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {   // loopback only — never expose the account to the LAN
  const mode = hasCredentials() ? 'LIVE (Fellow account configured)' : 'SIM only (no FELLOW_EMAIL/PASSWORD)';
  console.log(`Fellow mockup → http://localhost:${PORT}   [${mode}]`);
});
