# Architecture

## Workflow

```
 DONOR APP                    BLOOD CENTRE / HOSPITAL NODES                         NATIONAL / ABBIS
 ─────────                    ─────────────────────────────                         ────────────────
 register (type, ~location)
 sees matched appeals  ◄────── appeal published  ◄── draft appeal ◄─┐
 books slot at nearest site ─► pledge (expected donors list)        │
                               check-in ─► COLLECTED (donorRef)     │
                               lab ─────► TESTED (TTI panel)        │ unresolved
                               centre ──► DISPATCHED ─► RECEIVED    │ shortfall
                               clinician► RESERVED / ISSUED         │
                                          TRANSFUSED / RETURNED     │
                               any ─────► DISCARDED (reason)        │
                                    │                               │
                                    ▼                               │
                               event log ──► projections ──► forecaster ─► advisor ─┤
                                    │                                  transfer suggestions
                                    │                                  (officer approves → DISPATCHED)
                                    ▼
                               store-and-forward sync ◄──────────────► other nodes
                                    │
                                    └──► HL7 FHIR R4 facade ──────────► HMIS / DHIS2 / national platform
```

## Core decisions and why

### 1. Event sourcing for the unit lifecycle

Every change to a blood unit is an immutable event (`COLLECTED`, `TESTED`,
`DISPATCHED`, `RECEIVED`, `RESERVED`, `ISSUED`, `TRANSFUSED`, `RETURNED`,
`DISCARDED`). Current state is a projection rebuilt by replaying the events.

- **Traceability by construction.** The audit trail *is* the data. Haemovigilance
  look-back ("which patients got units from this donor?") is a query, not a
  reconstruction.
- **Safety rules in one place.** `src/domain/lifecycle.ts` is a pure state machine:
  an untested unit cannot be released, an expired unit cannot be issued, a
  reserved unit cannot go to another patient, and a unit can only be acted on at
  the site where it is. The same code validates local writes and replays merged
  logs.
- **Offline merging becomes possible** (next point).

### 2. Offline-first with hybrid logical clocks

Each facility can run its own node (the same binary, `NODE_ID`, `PEER_URL`).

- Events carry a **hybrid logical clock** timestamp (`src/sync/hlc.ts`): close to
  wall-clock time, never moving backwards if a device clock does, and always later
  than anything already received from a peer. This gives a single deterministic
  order across nodes without a central sequencer.
- **Sync is store-and-forward**, paged and resumable (`src/sync/sync.ts`). Each node
  remembers how far it has pulled from and pushed to each peer. Imports are
  idempotent on event id, so the only recovery rule on a bad link is to resend the
  page. Tested with a link that drops mid-sync.
- **Conflicts are surfaced, never silently resolved.** If two disconnected sites
  record incompatible events (the same unit issued twice), every node keeps both,
  applies the one that is earlier in HLC order, and raises a conflict for an
  inventory officer. In blood transfusion a silent "last write wins" could hide a
  patient-safety event; a held conflict cannot.
- The browser side also works offline: a service worker caches the app shell,
  reads fall back to the last good response, and writes go to a device outbox
  with a client-generated event id, so retries never duplicate.

### 3. Minimal runtime

Node.js built-ins only: `node:sqlite`, `node:http`, `node:crypto`, `node:test`.
There is no dependency tree to audit, no build step, and nothing to download at a
facility. SQLite in WAL mode handles a regional centre's volume (the simulator
writes ~50,000 events in 5 seconds). The national tier would move to PostgreSQL
behind the same `Store` interface (see PATHWAY.md).

### 4. Interoperability through HL7 FHIR, not a shared database

The internal model stays event-sourced; FHIR R4 is a **read facade**
(`src/fhir/mapper.ts`):

| Internal | FHIR R4 |
|---|---|
| Unit state | `BiologicallyDerivedProduct` (identifier = DIN, productCategory, status, storage period, blood group + location as extensions) |
| Each lifecycle event | `Provenance` (who, on behalf of which site, when, what) |
| Search | `GET /fhir/BiologicallyDerivedProduct?status=available&location=HOSP-ALPHA`, `GET /fhir/Provenance?target=...` |
| Capabilities | `GET /fhir/metadata` |

Code systems are placeholders (`example.org`) until a pilot agrees on ISBT 128
product codes and national terminology. Identifiers follow the ISBT 128 *shape*
(facility code, year, sequence) and include the component, because one donation
produces several products.

### 5. Security and privacy

- **Signed, expiring tokens** (HMAC-SHA256, constant-time verification). In a
  pilot these come from the national identity provider (OIDC) for staff and phone
  OTP for donors; the permission model does not change.
- **Role- and site-scoped permissions** (`src/auth.ts`). A lab technologist can
  record collection and screening; a clinician can issue and transfuse at
  their own hospital only; only an inventory officer at the *sending* site can
  approve a transfer; sync peers can only replicate.
- **Data minimisation.** The log stores pseudonymous donor and patient references,
  never names or national IDs; the identity mapping stays in the facility's own
  system. Donor location is rounded to about 1 km and used only for distance.
  Donors never see patient information: an appeal is a facility, a blood type
  and a quantity.
- **Every action is attributable**: actor, site, node and time are on every event.
- Routes validate inputs, cap body sizes and refuse path traversal. A missing
  `TOKEN_SECRET` stops production start-up.

## Data model

```
sites      (id, name, type blood_centre|hospital, region, lat, lon, collects)
events     (seq, id UNIQUE, din, type, site_id, actor, hlc, at, origin, payload JSON)   ← source of truth
units      (din, component, blood_group, status, site_id, expires_at, ...)              ← projection
conflicts  (event_id, din, reason, resolved_by, resolution)
demand     (site_id, blood_group, component, day, requested, fulfilled)                 ← unconstrained demand
suggestions(id, status open|approved|rejected, body, decided_by, decision_note)         ← AI decisions log
donors     (id, name, blood_group, group_verified, lat~1km, lon~1km, last_donation_at, sms_consent)
appeals    (id, site_id, blood_groups, units_needed, urgency, needed_by, status, source staff|ai_draft)
pledges    (id, donor_id, appeal_id, site_id, slot, status pledged|donated|deferred|cancelled, din)
peers      (url, pulled_seq, pushed_seq, last_error)
```

## API (selected)

| Method | Path | Who |
|---|---|---|
| POST | `/api/events` | staff, by role; idempotent on `id` |
| GET | `/api/units/:din` | staff: unit, full history, conflicts |
| GET | `/api/inventory`, `/api/forecast`, `/api/advisor`, `/api/ai/monitor` | staff |
| POST | `/api/suggestions/:id/approve` \| `/reject` | inventory officer at the sending site |
| GET/POST | `/api/appeals`, `/api/appeals/drafts`, `/api/pledges/:id/checkin` | staff |
| POST | `/api/donor/register`, `/api/donor/pledges` | donors |
| GET | `/api/donor/appeals`, `/api/donor/sites` | donors: matched and sorted by distance |
| GET/POST | `/sync/events`, `/sync/sites` | sync peers only |
| GET | `/fhir/...` | staff and integrated systems |

## Relationship to the ABBIS concept

This slice is designed as **one ABBIS node type**. The same software runs at a
hospital blood bank, a regional centre or a national hub; the role is a matter
of configuration and of which peers a node syncs with. ABBIS then becomes a
federation of nodes sharing one event model and one FHIR interface, so a country
can start with one region and grow, without a single central database that every
hospital must reach in real time.

## Adaptability

What differs between blood services is in `config/`, not code:

| Varies by country / service | Configured in |
|---|---|
| Component shelf lives (e.g. CPDA-1 vs SAGM red cells), storage text, FHIR category | `components` |
| Transfusion-transmissible infection screening panel | `ttiPanel` |
| Stock policy: safety days, transport lead time, expiry watch window | `inventoryPolicy` |
| Donation interval | `donor.minDaysBetweenDonations` |
| Appeal radius | `donor.appealReachKm` |
| Forecast history, holdout, interval width | `forecast` |
| Language (English and Kiswahili included) | `config/locales.json` |
| Maps provider | `GOOGLE_MAPS_API_KEY` (Google) or OpenStreetMap |

A deployment adds `config/<country>.json`, which is merged over the defaults
(`DEPLOYMENT=<country>`). New event types or rules go into the lifecycle state
machine, where they are covered by tests that run on every change.
