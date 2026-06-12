/* Electron main process for the Fellow Series 1 espresso app.
 *
 * - Loads index.html directly (file://, no localhost server, no open port).
 * - Exposes the Series 1 data over IPC via the shared fellow-client.mjs, so the
 *   Fellow credentials/JWT live ONLY in this Node main process and never reach
 *   the renderer (which stays sandboxed: contextIsolation on, nodeIntegration off).
 *
 * Run:   npm run app            (visible window)
 *        npm run app:smoke      (headless: boots, exercises IPC end-to-end, quits)
 *
 * Credentials: the desktop app stores them in the OS keychain via `safeStorage`
 * (a sign-in screen appears on first run); the repo `.env` is only a dev/browser
 * fallback and is never bundled. Tokens stay in this main process — see FELLOW_API.md
 * §2.1 on how sensitive they are (they drive profile writes + set-active).
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.setName('Curvia');   // app menu / About / dock name (dev; packaged uses productName)

// The shared client is ESM; import it once, lazily, from this CJS entry.
let clientPromise;
const client = () => (clientPromise ??= import(path.join(__dirname, 'fellow-client.mjs')));

ipcMain.handle('fellow:profiles', async () => (await client()).getProfiles());
ipcMain.handle('fellow:device', async () => (await client()).getDevice());
ipcMain.handle('fellow:setActive', async (_e, profileId) => (await client()).setActiveProfile(profileId));
ipcMain.handle('fellow:createProfile', async (_e, dto) => (await client()).createProfile(dto));
ipcMain.handle('fellow:updateProfile', async (_e, pid, dto) => (await client()).updateProfile(pid, dto));
ipcMain.handle('fellow:deleteProfile', async (_e, pid) => (await client()).deleteProfile(pid));
ipcMain.handle('fellow:roasters', async (_e, q) => (await client()).searchRoasterProfiles(q));
ipcMain.handle('fellow:resolveShared', async (_e, code) => (await client()).resolveSharedProfile(code));

// --- credential storage: encrypted via the OS keychain (Electron safeStorage) ---
// macOS Keychain / Windows DPAPI / Linux libsecret hold the key; the encrypted blob
// lives in userData. Plaintext credentials never touch disk.
const credsFile = () => path.join(app.getPath('userData'), 'curvia-creds.bin');
// Returns false (instead of throwing) when the OS keychain is unavailable, so a valid
// sign-in still works for the session — it just won't survive a restart.
function storeCreds(email, password) {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('curvia: OS keychain unavailable — sign-in will not persist across restarts');
    return false;
  }
  fs.writeFileSync(credsFile(), safeStorage.encryptString(JSON.stringify({ email, password })));
  return true;
}
function loadStoredCreds() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(credsFile())) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(credsFile())));
  } catch { return null; }
}
ipcMain.handle('fellow:authStatus', async () => (await client()).hasCredentials());
ipcMain.handle('fellow:signIn', async (_e, email, password) => {
  const c = await client();
  c.setCredentials(email, password);
  try {
    await c.getProfiles();          // validate against the API before persisting
    const persisted = storeCreds(email, password);   // only persist if the login actually worked
    return { ok: true, persisted };
  } catch (err) {
    c.setCredentials(null, null);
    return { ok: false, error: String(err.message || err) };
  }
});
ipcMain.handle('fellow:signOut', async () => {
  try { fs.rmSync(credsFile(), { force: true }); } catch { /* nothing to remove */ }
  (await client()).setCredentials(null, null);
  return { ok: true };
});

async function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    show: !process.env.FELLOW_SMOKE,           // smoke run stays invisible
    backgroundColor: '#0e0f12',
    title: 'Curvia',
    icon: path.join(__dirname, 'icon.png'),    // Win/Linux window icon (macOS uses the dock, set below)
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The app is a single local file; never follow external navigation or open windows
  // (defense-in-depth if markup ever gets injected via cloud profile text).
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(path.join(__dirname, 'icon.png'));
  const c = await client();           // env creds (.env, dev) win; otherwise load from the keychain
  if (!c.hasCredentials()) { const s = loadStoredCreds(); if (s) c.setCredentials(s.email, s.password); }
  const win = await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Headless end-to-end check: exercise the IPC bridge from the renderer, print, quit.
  if (process.env.FELLOW_SMOKE) {
    const result = await win.webContents.executeJavaScript(
      `window.fellowAPI
         ? window.fellowAPI.profiles()
             .then(p => 'profiles=' + (Array.isArray(p) ? p.length : '?'))
             .catch(e => 'ERR:' + e.message)
         : 'no-bridge'`
    );
    console.log('SMOKE:', result);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
