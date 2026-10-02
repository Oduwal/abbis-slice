# ABBIS slice

A working technical slice of an African Blood Bank Information System, built for
the Terumo BCT Africa Hackathon 2026.

**One loop, end to end:** a hospital is about to run short → the system forecasts
it → it first tries to fix it by moving stock that would otherwise expire
elsewhere → whatever is left becomes an appeal to nearby donors whose blood type
can help → a donor books a slot at the nearest site and gets Google Maps
directions → their donation enters a tamper-evident vein-to-vein record that
works offline and syncs when the network returns.

> **Synthetic data only.** Every donor, patient, unit and facility in this
> repository is generated. No real records are used or implied.

## Run it

Requires Node.js 22.6 or newer. **No dependencies to install.** The database
(SQLite), HTTP server, crypto and test runner are all built into Node, so it
installs and runs on an air-gapped laptop.

```bash
npm start            # first run generates 120 days of synthetic history (~5 s)
```

- Staff dashboard: http://localhost:4000
- Donor app (open on a phone, or use the browser's mobile view): http://localhost:4000/donor.html

```bash
npm test             # 26 tests: lifecycle rules, offline conflicts, sync, AI, donor matching, auth, FHIR
npm run eval         # rolling-origin backtest of the forecaster
npm run seed         # regenerate the synthetic data (SEED=7 DAYS=180 npm run seed)
```

Optional: `GOOGLE_MAPS_API_KEY=... npm start` uses Google Maps for the embedded
maps. Without a key, maps use OpenStreetMap and "Directions" still opens Google Maps.

### Two-node offline demo

```bash
npm start                    # terminal 1: central node on :4000
npm run start:hospital       # terminal 2: Hospital Alpha's own node on :4001
```

The hospital node pulls the network's log, then works on its own. Stop the
central node, record events at the hospital (http://localhost:4001), and restart
the central node: the hospital catches up automatically. If two sites issue the
same unit while disconnected, both records are kept, the earlier one stands, and
the other appears under **Sync & conflicts** for a person to resolve. The test
`the same unit issued at two offline sites becomes a conflict` runs this scenario.

## Demo script (5 minutes)

1. **Donor app** → "try a demo donor" → **O-**. They see Hospital Alpha's emergency
   O- appeal first (exact match, 9 km away), then an urgent O+ appeal that O- can
   also serve, with a note that they can give nearby and the unit will be sent on.
   Routine appeals are shown only to exact matches, so scarce O- donors are kept
   for urgent need.
2. Open the appeal → map, the nearest collection sites, directions → book a slot.
   The appeal's progress bar shows one more donor on the way.
3. **Staff dashboard** → sign in as *Inventory officer, Hospital Alpha* → **Donor appeals**
   → expected donors → **Donated**. A new unit appears in the log with the donor
   linked by a pseudonymous ID.
4. **Trace a unit** → the full chain of custody (collected → tested → dispatched →
   received → issued → transfused), each step signed by a role at a site, and as
   HL7 FHIR.
5. **Inventory** → stock by site × blood group, coloured by forecast risk.
   Click a cell → **Forecast**: history, the 7-day forecast with its P10–P90 band,
   and the backtest against two baselines.
6. **Advisor** → transfer suggestions with the numbers behind them. Approving one
   creates the dispatch events; rejecting one needs a reason, which is how the model
   gets reviewed. Shortfalls no transfer can fix become **draft donor appeals**
   that show how many eligible donors nearby they would reach.

## What's in it

| Deliverable | Where |
|---|---|
| Problem and user need | [docs/PROBLEM.md](docs/PROBLEM.md) |
| End-to-end workflow | [docs/ARCHITECTURE.md#workflow](docs/ARCHITECTURE.md#workflow) |
| Working technical slice | this repository |
| System architecture, data model, APIs, interoperability | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| AI and data approach, with evaluation | [docs/AI.md](docs/AI.md) |
| Adaptability across blood services | [docs/ARCHITECTURE.md#adaptability](docs/ARCHITECTURE.md#adaptability) |
| Implementation pathway, failure modes | [docs/PATHWAY.md](docs/PATHWAY.md) |

```
src/
  domain/      unit lifecycle state machine (pure, no I/O)
  store/       SQLite event log + projections
  sync/        hybrid logical clock, store-and-forward replication
  ai/          forecaster, transfer advisor, evaluation
  donor/       donors, appeals, pledges, blood type compatibility
  fhir/        HL7 FHIR R4 facade
  synthetic/   simulator that drives the real API to make history
  auth.ts      signed tokens, role- and site-scoped permissions
  server.ts    HTTP API + static files
public/        staff dashboard (index.html) and donor app (donor.html), no build step
config/        everything that differs between blood services
test/          node:test suites
```
