# CLAUDE.md

Guidance for working in this repo. **Curvia** — an unofficial **Fellow Espresso Series 1** profile
manager (Electron + browser) on the machine's reverse-engineered cloud API. Read `README.md` and
`FELLOW_API.md` for the full API map.

## ⚠️ This controls a real machine and a real account

- **Device writes mutate the user's actual espresso machine** (`setActiveProfile`, `createProfile`,
  `updateProfile`, `deleteProfile`). Treat any write as a state-changing op: **confirm with the user
  first**, and prefer the **reversible pattern** used throughout — change → verify via a re-read →
  restore, or create → verify → delete. `e2e_test.mjs` is the template.
- **Credentials are sensitive.** Dev/browser: `.env` (root). Desktop app: the OS keychain via Electron
  `safeStorage` (sign-in screen → `fellow-client.setCredentials`). **Never** print/log the password or
  JWT, **never** bundle `.env` into a build (the `package.json` `files` allowlist excludes it), and keep
  them in the Node/main process only — the renderer is sandboxed and must never receive tokens.
- **`live_test.mjs` reads the real account; `e2e_test.mjs` mutates it** (creates/deletes a profile).
  `smoke.mjs` is the only CI-safe suite (offline, no creds). Run mutating tests intentionally.

## Don't try to add what the API can't do (verified absent)

- **No live telemetry** — the machine syncs nothing during a shot. There is no temp/pressure/flow/timer
  feed; gauges/live-dashboards are impossible. Don't add them.
- **Remote brew is non-functional** — `start`/`stop`/`clean`/`rinse` return `200` but the firmware
  ignores them. Don't wire a "brew" button as if it works.
- **No shot history** in the cloud.

## Commands

```bash
npm run app        # Electron desktop app
npm run server     # browser version (http://localhost:8099)
npm test           # smoke.mjs — offline, no creds (use for quick checks / CI)
npm run test:live  # live_test.mjs — UI on real profiles, read-only
node e2e_test.mjs  # full CRUD against the device (mutates + self-cleans)
npm run pack|dist  # electron-builder: unpacked app | installers
```

## Architecture

- `fellow-client.mjs` — **single** cloud client (login/refresh + `getProfiles`/`getDevice` +
  CRUD writes). Both entry points reuse it. Loads `.env` verbatim (its own parser — do **not** use
  `node --env-file`, which truncates values at an unquoted `#`).
- `server.mjs` — browser proxy: serves `index.html` + `/api/{profiles,device,active-profile,roasters,shared}`
  and `POST`/`PATCH`/`DELETE /api/profiles` + `POST /api/profiles/{pid}/share`. `/api/roasters?q=`
  searches the global customs catalog; `/api/shared/{code}` resolves a brew.link share (public upstream,
  allowed credless) — both return other users' profiles (read-only; clone is the only device action).
  `POST …/share` mints a **permanent, irrevocable** public brew.link for one of the user's own customs. `electron-main.cjs`/`preload.cjs` expose the same over IPC
  (`window.fellowAPI`). The page prefers IPC, falls back to `/api/*`, then to simulated profiles.
- `index.html` — manager (folders/list/detail) + structured editor; all UI + JS inline.

## API conventions / gotchas (see FELLOW_API.md §2.1)

- Series 1 routes are `/v2/solo/devices/{FS_id}/…` (the `solo/` prefix); the Aiden uses `/v2/devices/…`.
- Write body = the **full profile DTO**; **omit `id`** (it's in the URL; `forbidNonWhitelisted` 400s
  otherwise). Stamp `settingsVersion: Math.floor(Date.now()/1000)` (client-clock LWW; `version` is not a
  write counter). **`DELETE` also requires a `{settingsVersion}` body.**
- Enums/ranges: `decliningTemp` is `on`/`off`; `transition`/`adaptive` are app-internal (pass-through,
  not user-editable). temp ≤94°C, dose 6–30g, ratio ≤5, grind ≤10, infusion pressure ≤9bar/≤120s.
- `transition`/`adaptive` must be **preserved on save** (clone the existing profile; don't drop fields).

## House style

- Verify runtime behavior by running it (tests + screenshots), not by reading the diff. The existing
  Playwright suites take screenshots to `shots/`.
- Keep edits surgical and matched to the surrounding inline style. After changing the UI, run
  `smoke.mjs` (offline) at minimum; run `live_test.mjs`/`e2e_test.mjs` when touching live/write paths.
