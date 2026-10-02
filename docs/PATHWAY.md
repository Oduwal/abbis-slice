# Implementation pathway

## Where it can fail, and what we do about it

| Failure | Consequence | Response in this design | Still open |
|---|---|---|---|
| Site offline for hours or days | Cannot see network stock | Local node keeps working; sync resumes from the last cursor; device outbox for the browser | Long partitions widen the conflict window, so they need a "reconcile on reconnect" step in SOPs |
| Two sites act on the same unit offline | Possible double issue | Both kept; earlier in causal order stands; conflict raised to a person on every node | Prevention needs physical rules too (a unit is held at one site) |
| Device clock wrong | Bad ordering | Hybrid logical clocks never go backwards and jump past peers' clocks | A grossly wrong clock still mis-stamps the `at` field; NTP check at start-up |
| Forecast wrong | Bad transfer suggestion | Human approval; P90 bands; backtest-gated fallback; rejection reasons reviewed | Needs real data to validate |
| Staff ignore suggestions | No benefit | Suggestions are few, ranked, and explained; the monitor tracks the approval rate | Change management is the bigger lever |
| Donor self-reports the wrong type | Wrong appeal shown | Group is typed at collection; a lab-confirmed group cannot be overwritten by the donor; check-in asks staff to confirm | First-time donors may make a wasted trip for a rare-type appeal |
| Appeal draws too many donors | Long queues, wasted goodwill | Pledges show "on the way" against "needed"; staff close appeals; routine appeals go only to exact matches | Slot capacity per site is not modelled yet |
| Token secret leaked | Forged access | Short-lived tokens; secret per deployment; OIDC in pilot | Key rotation procedure |
| SQLite outgrows a national hub | Slow queries | `Store` is the only module that touches SQL | PostgreSQL implementation for the hub tier |
| Integration partner reads FHIR differently | Bad data downstream | Read-only facade, CapabilityStatement | Profiles and terminology bindings with the national HIE |

## MVP architecture for a controlled pilot

```
              ┌──────────────────────── regional hub (cloud or ministry DC) ─────────────────────┐
              │  ABBIS node (PostgreSQL) · FHIR API · OIDC · SMS gateway · monitoring · backups  │
              └───────────────▲───────────────────────▲───────────────────────▲──────────────────┘
                              │ sync over HTTPS       │                       │
                 ┌────────────┴──────┐    ┌───────────┴───────┐   ┌───────────┴──────┐
                 │ regional blood    │    │ referral hospital │   │ district hospital │
                 │ centre node       │    │ node (mini PC)    │   │ (browser only,    │
                 │ (SQLite, UPS)     │    │                   │   │  offline outbox)  │
                 └───────────────────┘    └───────────────────┘   └───────────────────┘
                              donors: PWA + SMS/USSD for feature phones
```

- **Hospital node hardware:** any small PC or a recent Android tablet running
  Node, with a UPS. The software needs well under 1 GB of RAM.
- **Small facilities** can start with only the browser and the offline outbox,
  pointed at the nearest node.
- **Donors:** the PWA for smartphones; **SMS and USSD** through an aggregator
  for feature phones (the `sms_consent` flag and matching logic already exist;
  the gateway adapter is a pilot task). SMS is the channel that reaches most
  donors.

## Route from prototype to pilot

| Phase | Duration | Exit criteria |
|---|---|---|
| **0. Prototype** (this repo) | done | Working loop on synthetic data, tests green, evaluation published |
| **1. Discovery with one blood service** | 6–8 weeks | Data-sharing and ethics approvals; map their current registers and LIS; agree on ISBT 128 and terminology; obtain de-identified historical demand to re-run `npm run eval` |
| **2. Shadow mode, one region** (1 centre + 3–5 hospitals) | 3 months | Staff record events in parallel with current practice; forecasts and suggestions shown but not acted on; measure forecast skill on **real** data; usability fixes |
| **3. Controlled pilot** | 6 months | Suggestions acted on with approval; donor appeals live in one city; target metrics below; incident review process in place |
| **4. Scale decision** | — | Independent evaluation; national HIE integration; procurement and hosting model |

### Pilot metrics

- Expired red cell and platelet units as % of collected (target: fall versus baseline)
- Days with unmet requests per facility × blood type
- Forecast MAE and skill versus "same day last week", on real data
- Suggestion approval rate, and the reasons given for rejections
- Donor appeal conversion: pledges → donations → units issued
- Sync lag and conflict rate per site

## Technical dependencies

- Agreement on **identifiers** (ISBT 128 DIN and product codes) and a facility
  registry
- A **national identity provider** for staff (OIDC) and an SMS OTP provider for donors
- Interfaces to existing **LIS / blood bank software**, where it exists (FHIR or
  CSV import of screening results)
- **Hosting** for the hub that meets national data-residency rules
- An **SMS/USSD aggregator** account

## Operating it at scale

- One codebase for every node type keeps the release surface small; config-only
  differences per country.
- Backups: the event log is append-only, so continuous log shipping plus periodic
  snapshots is enough; projections can always be rebuilt.
- Every change to `src/domain/lifecycle.ts` is a change to patient-safety rules,
  so it needs a reviewer with transfusion expertise as well as the test suite.
