# Fellow Cloud API — Reverse-Engineering Notes

Unofficial notes on the Fellow coffee cloud API, focused on the **Espresso Series 1**
(internal codename **"Solo"**). Derived by inspecting the official Fellow app and probing
the live API with a real account. Fellow publishes **no** developer API; the only prior
community work (`9b/fellow-aiden`, `NewsGuyTor/FellowAiden-HomeAssistant`) covers the
**Aiden brewer only** — nothing existed for the Series 1 before these notes.

> **Status legend:** ✅ verified against the live API · 🟡 from the app's code, not yet
> exercised end-to-end · ❓ inferred / open question.

---

## 1. Backend & auth ✅

- **Single host (AWS API Gateway, us-west-2):**
  `https://l8qtmnc692.execute-api.us-west-2.amazonaws.com`
- **Two stages:** `/v1` (legacy, Aiden) and `/v2` (current). `/v3` does **not** exist.
- **Auth:** `POST /v1/auth/login` with `{"email","password"}` → `{ "accessToken", "refreshToken" }`.
  Credentials are the user's Fellow account (Shopify-customer-backed; the same login as the app).
  Send the JWT as `Authorization: Bearer <accessToken>` on subsequent calls.
  **No Cognito / SigV4 / IAM** is involved for REST (an early hypothesis; disproved).
- App `User-Agent` (not required, but matches the client): `Fellow/5 CFNetwork/1568.300.101 Darwin/24.2.0`
- Other auth endpoints seen in the app (🟡 not exercised): `/auth/refresh-token`,
  `/auth/sign-up`, `/auth/sign-out`, `/auth/recover`, `/auth/activate-account`,
  `/auth/email-status/`, `/auth/device/claimCertificate` (see §6, telemetry).

### Device id conventions ✅
- Aiden brewer ids are prefixed **`FB_`**; Series 1 ids are prefixed **`FS_`**.
- `deviceType` for the Series 1 is **`"Solo"`**; `sku` `1SRW-NA`.

---

## 2. Route map ✅

The account/device registry is **shared** across products; per-device routes are
**partitioned by product**. The Series 1 lives under a `/v2/solo/...` prefix that the
Aiden routes do not use — this was the crux that made `/v2/devices/{FS_id}/profiles` 404.

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/login` | JWT login (works for all products) ✅ |
| GET | `/v2/devices?dataType=real` | **Aggregated** list — returns *both* Aiden and Series 1 ✅ |
| GET | `/v2/devices/{FB_id}` · `…/profiles` · `…/schedules` | **Aiden only.** Returns 404 "Device could not be found" for `FS_` ids ✅ |
| GET | `/v2/solo/devices` | Series 1 collection ✅ |
| GET | `/v2/solo/devices/{FS_id}` | Series 1 device object (see §4) ✅ |
| GET | `/v2/solo/devices/{FS_id}/profiles` | **Series 1 espresso profiles (see §5).** Returns this account's `folder:"fellow"` built-ins + `folder:"drops"` items — **not** `custom` user profiles ✅ |
| ~~GET~~ | `/v2/solo/devices/{FS_id}/profiles/{pid}` | **Not deployed** — GET-by-id 403s "Missing Authentication Token". Read a single profile from the **list** route instead ✅(negative) |
| POST | `/v2/solo/devices/{FS_id}/profiles` | **Create profile** (body = profile DTO, see §2.1) ✅ **verified e2e** |
| PATCH | `/v2/solo/devices/{FS_id}/profiles/{pid}` | **Edit profile** — `temperature`/`infusion[]`/`decliningTemp`/`notes`/… ✅ **verified e2e** (see §2.1) |
| DELETE | `/v2/solo/devices/{FS_id}/profiles/{pid}` | **Delete profile** — ✅ **verified e2e**. ⚠ **requires a `{settingsVersion}` body** (else 400) |
| POST | `/v2/solo/devices/{FS_id}/profiles/{pid}/share` | **Share profile → public brew.link.** ✅ **verified e2e**: **no body** → `201 {"link":"https://brew.link/p/{code}/espresso"}`. ⚠ The link is a **PERMANENT, immutable snapshot** — it returns a copy captured at share time, survives deletion of the source profile, carries the pseudonymous `sharedFrom`, and has **no revoke** (DELETE on `.../share`, `/v2/shared/{code}`, etc. all 403). Same model as the iOS Share button. |
| GET | `/v2/shared/{code}/{deviceType}` | **Resolve a brew.link share code → full profile DTO.** PUBLIC — no auth (the brew.link web page resolves logged-out; it's `publicAxios` in that bundle). Series 1 uses `deviceType` `espresso`; param order is `{code}` then `{type}` (reversed 404s). DTO adds `sharedFrom` (stable pseudonymous sharer id), `createdAt`. ✅ verified 2026-06-11 with an own-account share link |
| PATCH | `/v2/solo/devices/{FS_id}/active-profile` | Set active profile (body `{profileId, settingsVersion}`) ✅ **verified e2e** (propagates to panel) |
| PATCH | `/v2/solo/devices/{FS_id}/{start\|stop\|clean\|rinse}` | **Remote brew/clean/rinse — NON-FUNCTIONAL.** Routes 200-accept but the machine ignores them; `start`+`rinse` verified no-op (see §7) ✅(negative) |
| GET | `/v2/solo/profiles` | **Global, unscoped catalog of all users' `custom` profiles** (~5k). Ignores `?userId=`/`?owner=`/`?mine=`/`?limit=`/`?offset=`. **The app never calls this** (0 refs in bundle) — likely an unintended/admin route (see §5.1) ✅ |
| GET·PATCH | `/v2/users/profile` | **Account record** (name/email/phone/notification prefs, Shopify-backed) — *not* espresso profiles ✅ |
| PATCH | `/v2/users/notifications` | Notification prefs ✅(exists) |
| GET | `/v2/solo/devices/{FS_id}/schedules` | **403 undefined on Solo** — schedules are Aiden-only despite the `schedules` enabledFlag ✅(negative) |
| PATCH | `/v2/devices/{FB_id}/selectedProfile?profileId=` | Aiden profile-select equivalent 🟡 |

`✅(exists)` = method+path confirmed live via the unauthenticated 401-vs-403 probe (technique below);
the request **body/response** for writes is recovered from the app bundle but **not exercised**
(no profile was created/edited/deleted against the account).

`dataType` query param is accepted but **ignored** for the Series 1 (real/reported/desired/
shadow all return the same object) ✅.

### 2.1 Write surface & conventions ✅ (bundle + a verified PATCH round-trip)

Per-device routes are built as **`getApiPrefix(deviceType) + "devices/" + deviceId + path`**.
`getApiPrefix` returns `deviceType.toLowerCase() + "/"` for the Series 1 → `solo/`, and `""` for the
Aiden brewer → so the *same* app code yields `/v2/solo/devices/…` vs `/v2/devices/…`. The `/v2/`
prefix and host come from build config (react-native-config / BuildConfig), not JS literals.

- **Edit a profile** = `PATCH /v2/solo/devices/{id}/profiles/{pid}` with the **profile body** below.
  ✅ **Verified end-to-end**: changed `temperature` (93.5→94) and `infusion[0].duration` (20→25) on a
  real profile, re-read confirmed both persisted (`synced:true`), then restored. **To set brew
  temperature, PATCH `temperature`** (whole-shot °C; see §5).
- **Body rules (NestJS `class-validator`, learned from 400s):**
  - **Omit `id`** — `{"message":["property id should not exist"]}` (forbidNonWhitelisted). The id is
    in the URL only. All other §5 brew fields are whitelisted (incl. `folder`, `notes`, `roasterName`).
  - Each write stamps `settingsVersion` via `withSettingsVersion(obj)` =
    `{...obj, settingsVersion: Math.floor(Date.now()/1000)}` — a **client-clock UNIX-seconds**
    last-write-wins token (*not* a server counter; the separate `version` field did **not** change).
  - PATCH validates the **whole DTO** (send the full profile, not a sparse patch). Sending pre-infusion
    fields with `preInfusionEnabled:false` is accepted but **server-normalized** to defaults
    (`hold 3 bar / flow 4.5 / 5 s`), so to keep pre-infusion off send those three as `null`.
- **Server-enforced ranges** (`400 "X must not be greater/less than N"`), i.e. the real firmware limits:

  | field | min | max | | field | min | max |
  |---|---|---|---|---|---|---|
  | `temperature` (°C) | 50 | **94** | | `infusion[].pressure` (bar) | — | 9 |
  | `dose` (g) | 6 | 30 | | `infusion[].duration` (s) | — | 120 |
  | `ratio` | — | 5 | | `rampDownEndPressure` (bar) | — | 9 |
  | `grindSize` | — | 10 | | | | |

  (Note: some existing `drops`/catalog profiles carry `temperature` up to 96 — older data predating
  the current `@Max(94)` validator; the server now rejects >94 on write.)
- **HTTP client** is one axios instance (`axiosInstance.{get,post,patch,delete}`); writes use
  lowercase method props (which is why only `GET`/`POST`/`HEAD` appear as *string literals*).
- **Full CRUD verified end-to-end** (via a disposable "My Test" profile, then deleted — `e2e_test.mjs`):
  **POST** create, **PATCH** edit (incl. `decliningTemp`, `notes`, `roasterName`), **DELETE**, and
  `…/active-profile` all work and propagate to the machine. ⚠ **`DELETE` requires a `{settingsVersion}`
  body** (same LWW token as the other writes) — without it: `400 "settingsVersion must be a number"`.
  `decliningTemp` enum is **`on` / `off`** (learned from a 400). (The brew commands, by contrast,
  200-accept but no-op — see §7.)

### Route-discovery technique (no credentials needed) ✅
On this API Gateway, unauthenticated GETs distinguish route states by status+message:
- **`401 {"message":"Unauthorized"}`** → route **exists** (behind the JWT authorizer).
- **`403 {"message":"Missing Authentication Token"}`** → resource **undefined** in an existing stage.
- **`403 {"message":"Forbidden"}`** → the **stage** itself doesn't exist (e.g. all of `/v3`).
- `403 "Invalid key=value pair … Authorization header"` → undefined resource hit **with** a
  Bearer header (AWS tries to parse it as SigV4). This is *noise*, not evidence of IAM auth.

This lets you map the surface (find new `/v2/solo/...` routes) before spending an auth round.

---

## 3. Source of truth: the app 🟡

- App: `com.fellowproducts.Fellow` (Android, by Fellow Industries). Pulled via
  `apkeep -a com.fellowproducts.Fellow -d apk-pure`.
- It is a **React Native** app; the JS is compiled to **Hermes bytecode** (`index.android.bundle`,
  Hermes v96). Decompile with `hermes-dec` (`hbc-disassembler`) to recover string literals and
  URL-building logic. The URL prefixes (`solo/devices/`, `/active-profile`, etc.) and the profile
  field names below all come from this bundle.
- ⚠️ Name collisions to avoid: `fellow.com` (parked, Japanese host), `app.fellow.com`
  (mis-attributed in a community issue), and `pl.fellow.fellowpl` (a Polish dating app) are
  **not** the coffee company. The coffee company is `fellowproducts.com` / the API host above.

---

## 4. Series 1 device object ✅

`GET /v2/solo/devices/{FS_id}` (and the shared `/v2/devices` list). ~29 fields; **no live brew
telemetry** (unlike the Aiden, whose object carries `heaterOn`/`pumpOn`/`brewing`). Key fields:

```jsonc
{
  "id": "FS_…", "displayName": "Espresso Series 1", "deviceType": "Solo", "sku": "1SRW-NA",
  "serialNumber": "…", "firmwareVersion": "2.3.20", "firmwareUpgradeRequired": false,
  "isConnected": true, "connectionTimestamp": "…ms",         // connection state
  "activeProfileId": "1_lightroast",                          // pointer at a profile id; here a folder:"fellow" built-in (see §5.1)
  "metricUnit": true, "preciseUnit": null,
  "dvolUnit": "m", "tempUnit": "m", "bvolUnit": "i", "whUnit": "m", "htUnit": "m", // unit prefs
  "showDrops": true, "settingsVersion": 1781113208, "version": 748,
  "enabledFlags": ["base","profiles","notifications","schedules","remoteBrewing"],
  "profiles": [/* this account's folder:"custom" profiles synced to THIS device */], "recipes": []
  // ↑ NOT always empty: holds device-bound custom profiles (empty until you create one). The
  //   /profiles route additionally merges in folder:"fellow" built-ins + folder:"drops" (see §5.1).
}
```

---

## 5. Series 1 espresso profile schema ✅ (the prize)

`GET /v2/solo/devices/{FS_id}/profiles` → array of profile objects. This is a **pressure-profiling**
model: *pre-infusion → infusion stage(s) → optional ramp-down*, which renders as a pressure-vs-time
curve (the app builds it via `generatePressureGraphData`).

```jsonc
{
  "id": "KXRDC0qOCS",
  "title": "Peru Umapata Community",
  "roasterName": "Camellia",
  "grindSize": 1.3,             // Fellow grinder scale (proprietary)
  "dose": 18,                   // grams in
  "ratio": 2,                   // yield multiplier → yield = dose × ratio (g out)
  "temperature": 92,            // °C (metricUnit)
  "transition": "smooth",       // enum (e.g. "smooth")
  "adaptive": true,             // bool
  "decliningTemp": "off",       // enum ("off" | …)

  "preInfusionEnabled": true,
  "preInfusionFillFlowRate": 4.5,   // 🟡 units ~ mL/s
  "preInfusionHoldPressure": 3,     // bar
  "preInfusionDuration": 5,         // seconds

  "infusion": [                     // ordered pressure stages (multi-stage supported)
    { "duration": 26, "pressure": 9 }   // seconds @ bar
  ],

  "rampDownEnabled": false,
  "rampDownEndPressure": 6,         // bar
  "rampDownDuration": 5,            // seconds

  "folder": "drops",                // source: "fellow" | "drops" | "custom" (see §5.1)

  // ── below: Drops-only publishing metadata (absent on custom/fellow profiles) ──
  "status": "ACTIVE",
  "scheduledAt": "…", "updatedAt": "…", "deletedAt": null,
  "notes": "…", "blurHash": "…",
  "imageUrl": "https://drops-images-production.s3.us-west-2.amazonaws.com/<id>.png"
}
```

When `preInfusionEnabled` is false the three `preInfusion*` fields are `null`. A multi-stage
example (declining-pressure shot): `"infusion": [{ "duration":15,"pressure":9 }, { "duration":15,"pressure":8 }]`.

**Brew temperature** is the top-level `temperature` field (°C when `metricUnit:true` on the device,
§4) — a single set-point for the whole shot, not per-stage. The optional `decliningTemp` enum
(`"off"` | on) is the only temperature *modifier*; the `infusion[]` stages vary pressure, not temp.

### 5.1 Folders — three profile sources ✅

`folder` marks where a profile comes from. **All three share the identical brew schema above**;
only the source route and the trailing metadata differ.

| `folder` | Appears in | Count (this acct) | Notes |
|---|---|---|---|
| `fellow` | device `/profiles` | 7 | Firmware built-ins: ids `1_lightroast`…`7_turboshot` (Light/Medium/Dark roast, Classic 9 bar, Lever, Modern arc, Turbo shot). `activeProfileId:"1_lightroast"` points at one of these. |
| `drops` | device `/profiles` | 10 | Fellow Drops subscription content. Adds the publishing metadata (`status`, `scheduledAt`, `updatedAt`, `deletedAt`, `blurHash`, `imageUrl`, populated `roasterName`/`notes`). |
| `custom` | device `/profiles` **and** global `/v2/solo/profiles` | 1 | User-created. **Appears on the per-device route once it's bound to a device** (a profile made on the machine's front panel syncs straight up). Same brew fields as Drops, **minus** publishing metadata; carries `synced` (bool), `version`, `settingsVersion`, and — on the per-device copy only — an **embedded `device` block** (serial, firmware, timezone, units). |

**The `custom` brew schema is not poorer than Drops.** "+ NEW" / the front panel support the full
vocabulary — multi-stage `infusion` (pressure staircases up to **10 stages** seen in the wild),
pre-infusion, ramp-down, declining-temp, adaptive. Of ~5,000 customs in the global catalog: ~794
are multi-stage, 4,333 use pre-infusion, 3,402 ramp-down, 726 declining-temp, 389 adaptive. The
only thing Drops adds is content chrome (photo, roaster, notes) — nothing that affects the shot.

**Where a custom profile shows up depends on origin** ✅ (verified by creating one on the panel):
- **Made on the device** → syncs up and appears on **`GET …/devices/{id}/profiles`** (folder
  `custom`, `synced:true`, embedded `device` block) **and** in the global catalog. This is how the
  app surfaces a user's own customs — the device object's embedded `profiles[]` holds exactly these.
- **Made in the app but not pushed to a device** → lands in the global catalog but was **not** seen
  on the per-device route in this account (it isn't device-bound).

⚠️ `GET /v2/solo/profiles` returns **every user's** customs, unscoped and unpaginated, with no
`userId`/`createdAt`/`updatedAt` — so you still can't isolate one account's customs *from the global
route*. Use the **per-device** route for your own device-bound customs.

---

## 6. Live telemetry (gauges) — no client channel found ✅(negative)

**There appears to be no client-facing live-telemetry feed** (real-time temp/pressure/flow).
Evidence, now from the app bundle as well as the API:
- **Verified by direct test during a live extraction** ✅(negative) — the decisive proof. Polled
  `GET /v2/solo/devices/{id}` once a second through a real **15 s shot** (44 polls over 60 s, machine
  at READY, empty portafilter). The device object was **100% static — not one field changed**: no
  `brewing` flag, no shot timer, no pressure/flow/temp. Even `connectionTimestamp`/`version`/
  `settingsVersion` never moved, i.e. **the machine syncs nothing to the cloud mid-shot** — the
  extraction is entirely local to the device. So there is no shot-progress to read, live or after.
- **No REST telemetry/history**: `…/state`, `…/shadow`, `…/telemetry`, `…/shots`, `…/sessions`,
  `…/history` all 403 (undefined); the device object carries no live brew fields (the Aiden's
  does — `heaterOn`/`pumpOn`/`brewing` — the Solo's does not). The **complete axios route
  inventory** recovered from the bundle (§2) contains *no* telemetry/shot-history endpoint — the
  only live-ish writes are command routes (`start`/`stop`/`clean`/`rinse`), which push, not read.
- **The only IoT in the app is device *provisioning*, not subscription.** The bundle's IoT-ish
  strings are all onboarding: `/auth/device/claimCertificate`, `/provision`, `currentProvisioning
  StepAtom`, `BLE … WiFi provisioning`, `Device was already provisioned`. There is **no** AWS IoT
  data endpoint (`*.iot.*.amazonaws.com`), **no** `mqtt`/`wss://` topic, and **no** Cognito pool.
- The device is an **ESP32** (Wi-Fi MAC OUI `dc:b4:d9` = Espressif) exposing **no inbound LAN
  ports** (full 1–1024 + IoT-port scan closed) — it claims an IoT cert and talks *outbound* to the
  cloud for OTA/config sync; the temp/pressure/flow sensors drive the machine's **internal** control
  loop and are not published to clients.
- ❓ Caveat: this is "not found in the current app build," not a proof of impossibility. A future
  app version, or a path not referenced in the JS, could expose it. But nothing reachable today does.

**Implication for UIs:** render profiles (§5) for real; the live gauges can only be a *simulated
playback* of the selected profile's pressure curve (what `index.html`/`server.mjs` here do).

---

## 7. Open questions / caveats

- ✅ **Built-in profiles — resolved.** They **are** returned by the device `/profiles` route,
  tagged `folder:"fellow"`, ids `1_lightroast`…`7_turboshot` (the earlier `?folder=` guess was
  wrong — the route already includes them). `activeProfileId:"1_lightroast"` points at one. See §5.1.
- ✅ **Finding your own custom profiles — resolved.** Device-bound customs **do** appear on
  `GET …/devices/{id}/profiles` (folder `custom`, `synced:true`, with an embedded `device` block),
  and the device object embeds them in `profiles[]`. Confirmed by creating "My Brew" on the
  machine's front panel — it synced up and showed on the per-device route within seconds (and also
  in the global catalog). The route looked custom-free earlier only because the account had no
  device-bound customs yet. App-made customs that aren't pushed to a device stay in the global
  catalog only. (The bundle never calls the global route — the app reads customs per-device.)
- ✅(negative) **Remote commands are NON-FUNCTIONAL.** `PATCH …/devices/{id}/{start|stop|clean|rinse}`
  all exist and **return `200`**, but the machine does **not** actuate. Verified end-to-end on
  **firmware 2.3.20** with the device's own panel as ground truth:
  - `start?confirm=true` (empty body) → `200` at **sleep**, **heating**, and **READY** — no brew in
    any state; the panel never changed.
  - `rinse` → `200` — no rinse cycle, no water, no panel change. (Note: the app sends `…/rinse`
    *without* `?confirm=true`; it 200s either way.)
  So the cloud accepts and relays commands (`isConnected:true`) but firmware ignores them — the
  `remoteBrewing` enabledFlag + these routes are present but unimplemented. Matches the Aiden, whose
  community found remote brew also doesn't fire. **The cloud API is effectively read/config only.**
  Caveat: bodies sent were empty/minimal; a `200` = accepted, and two verbs (one with `confirm`, one
  without) both no-op'd, so this is firmware-not-actuating rather than a payload problem — but a
  required-but-unknown body can't be 100% ruled out.
- ✅ **Schedules are Aiden-only.** `…/solo/devices/{id}/schedules` is 403-undefined despite the
  `schedules` enabledFlag on the Solo device object. The bundle's schedule CRUD targets the
  brewer (`devices/` prefix, `getApiPrefix("")`).
- 🔓 **Privacy note.** `/v2/solo/profiles` leaking all users' custom profiles to any authenticated
  account looks unintended — worth treating as a finding, not a feature.
- 🟡 Token lifetime / `refresh-token` flow not characterized; Aiden notes mention short-lived tokens.

---

## 8. Code in this repo

The one-off reverse-engineering/test scripts (`fellow_*.py`, `apk_analyze.py`, …) were removed after
the API was mapped — their techniques live in this doc (the **401/403 route discriminator** in §2, the
`hermes-dec` decompile in §3). To re-derive or re-verify, reproduce those. What remains is the app:

| File | Purpose |
|---|---|
| `fellow-client.mjs` | Shared cloud client: login/refresh, `getProfiles`/`getDevice`, and the **verified CRUD writes** `createProfile`/`updateProfile`/`deleteProfile`/`setActiveProfile`. Loads `.env` verbatim. |
| `server.mjs` | Local dev proxy → `index.html` + `/api/{profiles,device,active-profile}` and `POST`/`PATCH /api/profiles`. Run: `node server.mjs` (reads `.env`). |
| `electron-main.cjs` + `preload.cjs` | Desktop app: same client over IPC (`window.fellowAPI`), no open port. |
| `index.html` | Profile **manager** (folders/list/detail) + structured **editor** with save. Read profiles/device live; **Set Active** + **Edit→Save** are real writes; falls back to simulated profiles offline. |
| `smoke.mjs` / `live_test.mjs` | Playwright suites — offline/sim (no creds) and live (real account, read-only). |
| `e2e_test.mjs` | Full CRUD e2e — creates a disposable "My Test" via the editor UI, edits it, deletes it (mutates the device; always cleans up). |

---

*Derived from Fellow app v1.4.3 (Hermes bundle, decompiled with `hermes-dec`) + live probing of one
Series 1 account, firmware 2.3.20. **The full CRUD write surface — POST/PATCH/DELETE profiles +
active-profile — is verified end-to-end** against the real machine (§2.1, `e2e_test.mjs`). Endpoints/
schema may change; re-verify with the 401/403 technique in §2 before relying on them.*
