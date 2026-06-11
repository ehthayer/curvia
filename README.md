# Curvia

**Curvia** is an **unofficial** desktop/web profile manager for the **Fellow Espresso Series 1**, built on the
machine's (undocumented) cloud API. Browse your real profiles, view recipe + pressure curve + tasting
notes, set the active profile, and create/edit/delete profiles that sync to the machine.

> Not affiliated with, endorsed by, or sponsored by Fellow. For personal use with your own account.
> It talks to Fellow's cloud the same way the official app does, using **your** credentials.

## What it does (and doesn't)

✅ **Works, verified end-to-end against a real Series 1:**
- List/filter profiles by folder (Drops / Custom / Built-in) + search
- Profile detail: pressure curve, full recipe (temp/dose/ratio/grind/pre-infusion/infusion/ramp-down),
  declining-temp, roaster, tasting notes, photo, and the **active** profile (★)
- **Set Active** — changes the machine's active profile (propagates to the front panel)
- **Create / Edit / Delete** profiles — structured editor with a live curve; saves to the machine

❌ **Not possible (the cloud doesn't expose it — see `FELLOW_API.md`):**
- **No live telemetry** — the machine syncs nothing during a shot (no temp/pressure/flow/timer)
- **No remote brewing** — `start`/`stop`/`clean`/`rinse` routes exist but the firmware ignores them
- **No shot history** — not stored in the cloud

So this is **profile management + set-active**, not a remote-control or live dashboard.

## Quick start

Requirements: **Node 20+**. Credentials in a `.env` at the repo root (your Fellow account — the same
login as the app):

```
FELLOW_EMAIL=you@example.com
FELLOW_PASSWORD=your-password        # a literal '#' is fine — the loader parses it verbatim
```

```bash
npm install

npm run app        # desktop app (Electron) — recommended
npm run server     # browser version at http://localhost:8099
```

**Desktop app:** with no `.env`, it shows a **sign-in screen** on first run and stores your credentials
in the **OS keychain** (Electron `safeStorage`) — `.env` is just a dev shortcut. Without either, the UI
runs on built-in **simulated** profiles.

## Build a distributable

```bash
npm run pack       # unpacked app in dist/  (fast, no installer)
npm run dist       # installers: .dmg (mac) / .exe (win) / .AppImage (linux)
```

The build **excludes `.env`** — credentials never ship in the binary; the packaged app uses the
keychain sign-in instead. (For public distribution you'd also **code-sign** the app — see `electron-main.cjs`.)

## How it works

```
 index.html (renderer)  ──IPC──▶  electron-main.cjs ─┐
        │  or  fetch /api/*  ──▶  server.mjs ─────────┤──▶  fellow-client.mjs  ──▶  Fellow cloud API
        │                                              │      (login, GET/POST/PATCH/DELETE)
   simulated fallback (no creds)                       └──  credentials stay in the Node process,
                                                            never reach the renderer/browser
```

`fellow-client.mjs` is the single source of truth for auth + the read/write calls. The browser path
(`server.mjs`) and desktop path (`electron-main.cjs`) both reuse it; the renderer is sandboxed
(`contextIsolation` on, `nodeIntegration` off) and only sees data, never tokens.

## Testing

```bash
npm test           # smoke.mjs   — offline/simulated, no creds, CI-safe (Playwright)
npm run test:live  # live_test.mjs — drives the UI on your REAL profiles, read-only
node e2e_test.mjs  # full CRUD — creates "My Test", edits it, deletes it (mutates, then cleans up)
```

## Reverse-engineering notes

The cloud API was reverse-engineered from the Fellow app + live probing. The full map — hosts, auth,
the `/v2/solo/devices/…` route surface, the profile schema, write conventions, and what *doesn't*
exist — is in **[`FELLOW_API.md`](./FELLOW_API.md)**.

## Layout

```
index.html          profile-manager UI + structured editor
fellow-client.mjs   shared cloud client (auth, CRUD)
server.mjs          browser dev proxy (serves index.html + /api/*)
electron-main.cjs   desktop entry         preload.cjs  IPC bridge
smoke.mjs           offline tests         live_test.mjs / e2e_test.mjs  live tests
icon.{svg,png,icns} app icon (a pressure curve — original, no Fellow branding)
FELLOW_API.md       reverse-engineering reference
```
