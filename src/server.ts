import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { Store, RejectedError } from './store/store.ts';
import { loadConfig, loadLocales, ROOT, type Config } from './config.ts';
import { sign, verify, canRecord, can, type Principal, type Action } from './auth.ts';
import { advise, type AdvisorResult, type Suggestion } from './ai/advisor.ts';
import { forecast } from './ai/forecast.ts';
import { toBiologicallyDerivedProduct, toProvenance, bundle } from './fhir/mapper.ts';
import { syncWith, httpPeer } from './sync/sync.ts';
import { generate, generateDonors } from './synthetic/generate.ts';
import { Donors, matchLevel, compatibleDonors, type Urgency } from './donor/donors.ts';
import { BLOOD_GROUPS, COMPONENTS } from './domain/types.ts';
import type { BloodGroup, Component, EventType, Role, Site } from './domain/types.ts';

// ---------- boot ----------

const PORT = Number(process.env.PORT ?? 4000);
const NODE_ID = process.env.NODE_ID ?? 'central';
const DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data/central.db');
const PEER_URL = process.env.PEER_URL ?? '';
const SITE_SCOPE = process.env.SITE_SCOPE ?? '';
const DEMO = process.env.DEMO !== '0';
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 30_000);

const config: Config = loadConfig();
const locales = loadLocales();
const fresh = !existsSync(DB_PATH);
const store = new Store(DB_PATH, NODE_ID);
const donors = new Donors(store, config.donor.minDaysBetweenDonations);
if (fresh && !PEER_URL && process.env.AUTO_SEED !== '0') {
  console.log('Empty database: generating synthetic history (set AUTO_SEED=0 to skip)...');
  const r = generate(store, config, { days: 120, endDay: new Date().toISOString().slice(0, 10), seed: 42 });
  const d = generateDonors(store, donors, config, { count: 400, seed: 42 });
  console.log(`  ${r.units} donations, ${r.events} events, ${d.donors} donors`);
}
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';

// ---------- helpers ----------

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const payload = type.includes('json') ? JSON.stringify(body) : (body as string | Buffer);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 5_000_000) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function principal(req: IncomingMessage): Principal {
  const h = req.headers.authorization ?? '';
  const p = verify(h.startsWith('Bearer ') ? h.slice(7) : undefined);
  if (!p) throw new HttpError(401, 'sign in required');
  return p;
}

function authorize(p: Principal, action: Action, siteId?: string) {
  const why = can(p, action, siteId);
  if (why) throw new HttpError(403, why);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (!allowed.includes(value as T)) throw new HttpError(400, `${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}

// ---------- demo identities ----------

interface DemoUser {
  id: string;
  name: string;
  role: Role;
  siteId: string | null;
}

function demoUsers(): DemoUser[] {
  const users: DemoUser[] = [{ id: 'admin', name: 'System administrator', role: 'admin', siteId: null }];
  for (const s of store.sites()) {
    if (s.type === 'blood_centre') users.push({ id: `lab-${s.id}`, name: `Lab technologist, ${s.name}`, role: 'lab_tech', siteId: s.id });
    users.push({ id: `inv-${s.id}`, name: `Inventory officer, ${s.name}`, role: 'inventory_officer', siteId: s.id });
    if (s.type === 'hospital') users.push({ id: `clin-${s.id}`, name: `Clinician, ${s.name}`, role: 'clinician', siteId: s.id });
  }
  return users;
}

// ---------- advisor (cached per log position) ----------

let advisorCache: { seq: number; at: number; result: AdvisorResult } | null = null;

function currentAdvice(): AdvisorResult {
  const seq = store.headSeq();
  if (advisorCache && advisorCache.seq === seq && Date.now() - advisorCache.at < 5 * 60_000) return advisorCache.result;
  const result = advise(store, config);
  const insert = store.db.prepare("INSERT OR IGNORE INTO suggestions (id, created_at, status, body) VALUES (?, ?, 'open', ?)");
  store.transaction(() => {
    for (const s of result.suggestions) insert.run(s.id, result.asOf, JSON.stringify(s));
  });
  advisorCache = { seq, at: Date.now(), result };
  return result;
}

function withDecisions(suggestions: Suggestion[]) {
  const get = store.db.prepare('SELECT status, decided_by, decided_at, decision_note FROM suggestions WHERE id = ?');
  return suggestions.map((s) => {
    const d = get.get(s.id) as { status: string; decided_by: string | null; decided_at: string | null; decision_note: string | null };
    return { ...s, status: d?.status ?? 'open', decidedBy: d?.decided_by ?? null, decisionNote: d?.decision_note ?? null };
  });
}

// ---------- sync loop ----------

const peerToken = sign({ sub: `node:${NODE_ID}`, name: `Node ${NODE_ID}`, role: 'sync_peer', siteId: null }, 365 * 24 * 3600);
let lastSync: Awaited<ReturnType<typeof syncWith>> & { at?: string } = { pulled: 0, pushed: 0, conflicts: 0 };
let syncing = false;

async function syncNow() {
  if (!PEER_URL || syncing) return lastSync;
  syncing = true;
  try {
    // Reference data (sites) first, then the event log.
    try {
      const res = await fetch(`${PEER_URL}/sync/sites`, { headers: { authorization: `Bearer ${peerToken}` }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) for (const s of (await res.json()) as Site[]) store.upsertSite(s);
    } catch {
      /* reported by the event sync below */
    }
    lastSync = { ...(await syncWith(store, PEER_URL, httpPeer(PEER_URL, peerToken))), at: new Date().toISOString() };
    if (lastSync.pulled || lastSync.pushed) console.log(`[sync] ${JSON.stringify(lastSync)}`);
  } finally {
    syncing = false;
  }
  return lastSync;
}

if (PEER_URL) {
  setInterval(() => void syncNow(), SYNC_INTERVAL_MS).unref();
  setTimeout(() => void syncNow(), 1000).unref();
}

// ---------- routes ----------

type Handler = (ctx: { req: IncomingMessage; url: URL; params: string[] }) => Promise<unknown> | unknown;
const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
const route = (method: string, path: string, handler: Handler) =>
  routes.push({ method, pattern: new RegExp('^' + path.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$'), handler });

route('GET', '/api/health', () => ({ ok: true, node: NODE_ID, peer: PEER_URL || null, ...store.stats(), headSeq: store.headSeq() }));

route('GET', '/api/config', () => ({
  node: NODE_ID,
  siteScope: SITE_SCOPE || null,
  deployment: config.deployment,
  locale: config.locale,
  locales,
  components: config.components,
  bloodGroups: BLOOD_GROUPS,
  policy: config.inventoryPolicy,
  demo: DEMO,
  googleMapsApiKey: MAPS_KEY || null,
}));

route('GET', '/api/demo-users', () => {
  if (!DEMO) throw new HttpError(404, 'demo mode disabled');
  return demoUsers();
});

route('POST', '/api/login', async ({ req }) => {
  if (!DEMO) throw new HttpError(404, 'demo login disabled; use the identity provider');
  const { userId } = await readJson(req);
  const u = demoUsers().find((x) => x.id === userId);
  if (!u) throw new HttpError(404, 'unknown demo user');
  return { token: sign({ sub: u.id, name: u.name, role: u.role, siteId: u.siteId }), user: u };
});

route('GET', '/api/sites', ({ req }) => {
  authorize(principal(req), 'read');
  return store.sites();
});

route('GET', '/api/inventory', ({ req }) => {
  authorize(principal(req), 'read');
  const advice = currentAdvice();
  return { asOf: advice.asOf, summary: store.inventorySummary(advice.asOf), assessments: advice.assessments };
});

route('GET', '/api/units', ({ req, url }) => {
  authorize(principal(req), 'read');
  const q = Object.fromEntries(url.searchParams);
  return store.units({ siteId: q.siteId, status: q.status, component: q.component, bloodGroup: q.bloodGroup, limit: Math.min(Number(q.limit ?? 200), 1000) });
});

route('GET', '/api/units/:din', ({ req, params }) => {
  authorize(principal(req), 'read');
  const din = decodeURIComponent(params[0]);
  const unit = store.unit(din);
  if (!unit) throw new HttpError(404, `no unit ${din}`);
  const conflicts = store.conflicts(true).filter((c) => c.din === din);
  return { unit, events: store.events(din), conflicts };
});

route('POST', '/api/events', async ({ req }) => {
  const p = principal(req);
  const b = await readJson(req);
  const type = oneOf(b.type, ['COLLECTED', 'TESTED', 'RESERVED', 'DISPATCHED', 'RECEIVED', 'ISSUED', 'TRANSFUSED', 'RETURNED', 'DISCARDED'] as EventType[], 'type');
  if (typeof b.din !== 'string' || !b.din) throw new HttpError(400, 'din required');
  const siteId = String(b.siteId ?? p.siteId ?? '');
  if (!store.site(siteId)) throw new HttpError(400, `unknown site ${siteId}`);
  const why = canRecord(p, type, siteId);
  if (why) throw new HttpError(403, why);
  const payload = (b.payload ?? {}) as Record<string, unknown>;
  if (type === 'COLLECTED') {
    const component = oneOf(payload.component, COMPONENTS, 'component');
    oneOf(payload.bloodGroup, BLOOD_GROUPS, 'bloodGroup');
    const at = b.at ? Date.parse(b.at) : Date.now();
    payload.expiresAt ??= new Date(at + config.components[component].shelfLifeDays * 86_400_000).toISOString();
  }
  // Client-supplied id makes retries from an offline outbox idempotent.
  return store.append({ id: typeof b.id === 'string' ? b.id : undefined, din: b.din, type, siteId, actor: p.sub, at: b.at, payload });
});

route('POST', '/api/demand', async ({ req }) => {
  const p = principal(req);
  const b = await readJson(req);
  const siteId = String(b.siteId ?? p.siteId);
  authorize(p, 'record_demand', siteId);
  const bloodGroup = oneOf(b.bloodGroup, BLOOD_GROUPS, 'bloodGroup') as BloodGroup;
  const component = oneOf(b.component, COMPONENTS, 'component') as Component;
  const day = typeof b.day === 'string' ? b.day : new Date().toISOString().slice(0, 10);
  store.recordDemand(siteId, bloodGroup, component, day, Number(b.requested ?? 1), Number(b.fulfilled ?? 0));
  return { ok: true };
});

route('GET', '/api/advisor', ({ req }) => {
  authorize(principal(req), 'read');
  const a = currentAdvice();
  return { asOf: a.asOf, suggestions: withDecisions(a.suggestions), alerts: a.alerts };
});

route('POST', '/api/suggestions/:id/approve', async ({ req, params }) => {
  const p = principal(req);
  const { note } = await readJson(req);
  const row = store.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(params[0]) as { status: string; body: string } | undefined;
  if (!row) throw new HttpError(404, 'unknown suggestion');
  if (row.status !== 'open') throw new HttpError(409, `suggestion already ${row.status}`);
  const s = JSON.parse(row.body) as Suggestion;
  authorize(p, 'approve_suggestion', s.fromSiteId);
  const asOf = new Date().toISOString();
  const dispatched: string[] = [];
  const skipped: { din: string; reason: string }[] = [];
  store.transaction(() => {
    for (const din of s.dins) {
      try {
        store.append({ din, type: 'DISPATCHED', siteId: s.fromSiteId, actor: p.sub, at: asOf, payload: { toSiteId: s.toSiteId, suggestionId: s.id } });
        dispatched.push(din);
      } catch (err) {
        if (!(err instanceof RejectedError)) throw err;
        skipped.push({ din, reason: err.message }); // stock moved since the suggestion was made
      }
    }
    store.db
      .prepare("UPDATE suggestions SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?")
      .run(p.sub, asOf, note ?? null, s.id);
  });
  return { dispatched, skipped };
});

route('POST', '/api/suggestions/:id/reject', async ({ req, params }) => {
  const p = principal(req);
  const { note } = await readJson(req);
  if (!note || String(note).trim().length < 3) throw new HttpError(400, 'a short reason is required: it is how the model gets reviewed');
  const row = store.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(params[0]) as { status: string; body: string } | undefined;
  if (!row) throw new HttpError(404, 'unknown suggestion');
  if (row.status !== 'open') throw new HttpError(409, `suggestion already ${row.status}`);
  authorize(p, 'approve_suggestion', (JSON.parse(row.body) as Suggestion).fromSiteId);
  store.db
    .prepare("UPDATE suggestions SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?")
    .run(p.sub, new Date().toISOString(), String(note), params[0]);
  return { ok: true };
});

route('GET', '/api/forecast', ({ req, url }) => {
  authorize(principal(req), 'read');
  const siteId = url.searchParams.get('siteId') ?? '';
  const bloodGroup = oneOf(url.searchParams.get('bloodGroup'), BLOOD_GROUPS, 'bloodGroup');
  const component = oneOf(url.searchParams.get('component'), COMPONENTS, 'component');
  const rows = store.demandSeries(siteId, bloodGroup, component).map((r) => ({ day: r.day, value: r.requested }));
  const f = forecast(rows, new Date().toISOString().slice(0, 10), {
    horizon: config.inventoryPolicy.forecastHorizonDays,
    ...config.forecast,
  });
  const fulfilled = new Map(store.demandSeries(siteId, bloodGroup, component).map((r) => [r.day, r.fulfilled]));
  return { ...f, history: f.history.slice(-84).map((h) => ({ ...h, fulfilled: fulfilled.get(h.day) ?? 0 })) };
});

route('GET', '/api/ai/monitor', ({ req }) => {
  authorize(principal(req), 'read');
  const a = currentAdvice();
  const tested = a.assessments.filter((x) => x.forecast.backtest);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((p, q) => p + q, 0) / xs.length) * 1000) / 1000 : null);
  const models: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  for (const x of a.assessments) {
    models[x.forecast.model] = (models[x.forecast.model] ?? 0) + 1;
    confidence[x.forecast.confidence] = (confidence[x.forecast.confidence] ?? 0) + 1;
  }
  const decisions = store.db
    .prepare('SELECT status, COUNT(*) AS n FROM suggestions GROUP BY status')
    .all() as { status: string; n: number }[];
  const rejections = store.db
    .prepare("SELECT id, decided_by AS decidedBy, decided_at AS decidedAt, decision_note AS note FROM suggestions WHERE status = 'rejected' ORDER BY decided_at DESC LIMIT 20")
    .all();
  return {
    asOf: a.asOf,
    series: a.assessments.length,
    models,
    confidence,
    backtest: {
      series: tested.length,
      meanSkillVsSeasonalNaive: avg(tested.map((x) => x.forecast.backtest!.skill)),
      share_beating_naive: avg(tested.map((x) => (x.forecast.backtest!.skill > 0 ? 1 : 0))),
      meanMAE: avg(tested.map((x) => x.forecast.backtest!.maeModel)),
    },
    decisions: Object.fromEntries(decisions.map((d) => [d.status, d.n])),
    recentRejections: rejections,
  };
});

route('GET', '/api/conflicts', ({ req }) => {
  authorize(principal(req), 'read');
  return store.conflicts();
});

route('POST', '/api/conflicts/:id/resolve', async ({ req, params }) => {
  const p = principal(req);
  authorize(p, 'resolve_conflict');
  const { resolution } = await readJson(req);
  if (!resolution) throw new HttpError(400, 'resolution note required');
  if (!store.resolveConflict(decodeURIComponent(params[0]), p.sub, String(resolution))) throw new HttpError(404, 'no open conflict with that id');
  return { ok: true };
});

route('GET', '/api/sync/status', ({ req }) => {
  authorize(principal(req), 'read');
  return { node: NODE_ID, peer: PEER_URL || null, headSeq: store.headSeq(), last: lastSync, peers: store.db.prepare('SELECT * FROM peers').all() };
});

route('POST', '/api/sync/now', async ({ req }) => {
  authorize(principal(req), 'read');
  if (!PEER_URL) throw new HttpError(400, 'this node has no PEER_URL configured');
  return syncNow();
});

// Node-to-node replication.
route('GET', '/sync/events', ({ req, url }) => {
  authorize(principal(req), 'sync');
  return store.exportSince(Number(url.searchParams.get('since') ?? 0), Math.min(Number(url.searchParams.get('limit') ?? 500), 2000));
});

route('POST', '/sync/events', async ({ req }) => {
  authorize(principal(req), 'sync');
  const { events } = await readJson(req);
  if (!Array.isArray(events)) throw new HttpError(400, 'events[] required');
  advisorCache = null;
  return store.importEvents(events);
});

route('GET', '/sync/sites', ({ req }) => {
  authorize(principal(req), 'sync');
  return store.sites();
});

// ---------- donor app ----------

const URGENCY_RANK: Record<string, number> = { emergency: 0, urgent: 1, routine: 2 };
const siteById = (id: string) => store.site(id);

function donorPrincipal(req: IncomingMessage) {
  const p = principal(req);
  authorize(p, 'donor');
  const d = donors.get(p.sub);
  if (!d) throw new HttpError(401, 'donor account not found');
  return d;
}

function pledgeView(pl: ReturnType<Donors['pledges']>[number]) {
  const s = siteById(pl.siteId);
  return { ...pl, siteName: s?.name ?? pl.siteId, lat: s?.lat, lon: s?.lon };
}

route('GET', '/api/donor/demo-accounts', () => {
  if (!DEMO) throw new HttpError(404, 'demo mode disabled');
  // One eligible donor per blood group, so judges can see matching change.
  const out = [];
  for (const g of BLOOD_GROUPS) {
    const d = donors.all(1000).find((x) => x.bloodGroup === g && donors.eligibility(x).eligible && x.lat !== null);
    if (d) out.push({ id: d.id, name: d.name, bloodGroup: d.bloodGroup });
  }
  return out;
});

route('POST', '/api/donor/login', async ({ req }) => {
  if (!DEMO) throw new HttpError(404, 'demo login disabled; use phone OTP');
  const { donorId } = await readJson(req);
  const d = donors.get(String(donorId));
  if (!d) throw new HttpError(404, 'unknown donor');
  return { token: sign({ sub: d.id, name: d.name, role: 'donor', siteId: null }, 30 * 24 * 3600), donor: d };
});

route('POST', '/api/donor/register', async ({ req }) => {
  const b = await readJson(req);
  const name = String(b.name ?? '').trim();
  if (name.length < 2) throw new HttpError(400, 'name required');
  const bloodGroup = b.bloodGroup === 'unknown' ? 'unknown' : oneOf(b.bloodGroup, BLOOD_GROUPS, 'bloodGroup');
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const d = donors.register({
    name,
    bloodGroup,
    lat: num(b.lat),
    lon: num(b.lon),
    phone: b.phone ? String(b.phone) : null,
    smsConsent: !!b.smsConsent,
    lastDonationAt: typeof b.lastDonationAt === 'string' && b.lastDonationAt ? new Date(b.lastDonationAt).toISOString() : null,
  });
  return { token: sign({ sub: d.id, name: d.name, role: 'donor', siteId: null }, 30 * 24 * 3600), donor: d };
});

route('GET', '/api/donor/me', ({ req }) => {
  const d = donorPrincipal(req);
  return { donor: d, eligibility: donors.eligibility(d), pledges: donors.pledges({ donorId: d.id }).map(pledgeView) };
});

route('PUT', '/api/donor/me', async ({ req }) => {
  const d = donorPrincipal(req);
  const b = await readJson(req);
  const patch: Parameters<Donors['update']>[1] = {};
  if (typeof b.lat === 'number' && typeof b.lon === 'number') Object.assign(patch, { lat: b.lat, lon: b.lon });
  if (b.bloodGroup) patch.bloodGroup = b.bloodGroup === 'unknown' ? 'unknown' : oneOf(b.bloodGroup, BLOOD_GROUPS, 'bloodGroup');
  if (typeof b.smsConsent === 'boolean') patch.smsConsent = b.smsConsent;
  return donors.update(d.id, patch);
});

route('GET', '/api/donor/appeals', ({ req }) => {
  const d = donorPrincipal(req);
  const here = d.lat !== null && d.lon !== null ? { lat: d.lat, lon: d.lon } : null;
  const options = donors.donationOptions(here);
  return donors
    .appeals('open')
    .map((a) => {
      const site = siteById(a.siteId)!;
      const match = matchLevel(d.bloodGroup, a.bloodGroups);
      const opts = donors.donationOptions(here, a.siteId).slice(0, 3);
      return {
        ...a,
        siteName: site.name,
        lat: site.lat,
        lon: site.lon,
        distanceKm: here ? options.find((o) => o.id === a.siteId)?.distanceKm ?? null : null,
        match,
        acceptsDonors: a.bloodGroups.flatMap(compatibleDonors).filter((g, i, xs) => xs.indexOf(g) === i),
        donationOptions: opts,
      };
    })
    // Routine appeals go to exact matches only, so scarce universal (O-) donors
    // are kept for appeals that really need them.
    .filter((a) => a.match === 'exact' || a.match === 'unknown' || (a.match === 'compatible' && a.urgency !== 'routine'))
    .sort(
      (x, y) =>
        (x.match === 'exact' ? 0 : 1) - (y.match === 'exact' ? 0 : 1) ||
        URGENCY_RANK[x.urgency] - URGENCY_RANK[y.urgency] ||
        (x.distanceKm ?? 0) - (y.distanceKm ?? 0),
    );
});

route('GET', '/api/donor/sites', ({ req }) => {
  const d = donorPrincipal(req);
  return donors.donationOptions(d.lat !== null && d.lon !== null ? { lat: d.lat, lon: d.lon } : null);
});

route('POST', '/api/donor/pledges', async ({ req }) => {
  const d = donorPrincipal(req);
  const b = await readJson(req);
  const slot = typeof b.slot === 'string' && !Number.isNaN(Date.parse(b.slot)) ? new Date(b.slot).toISOString() : null;
  if (!slot) throw new HttpError(400, 'slot (ISO time) required');
  try {
    return pledgeView(donors.pledge({ donorId: d.id, appealId: b.appealId ? String(b.appealId) : null, siteId: String(b.siteId), slot }));
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
});

route('POST', '/api/donor/pledges/:id/cancel', ({ req, params }) => {
  const d = donorPrincipal(req);
  const pl = donors.getPledge(params[0]);
  if (!pl || pl.donorId !== d.id) throw new HttpError(404, 'no such pledge');
  if (pl.status !== 'pledged') throw new HttpError(409, `pledge is ${pl.status}`);
  donors.setPledgeStatus(pl.id, 'cancelled');
  return { ok: true };
});

// ---------- appeals (staff side) ----------

route('GET', '/api/appeals', ({ req }) => {
  authorize(principal(req), 'read');
  return donors.appeals('all').map((a) => ({ ...a, siteName: siteById(a.siteId)?.name, reach: donors.reach(a, config.donor.appealReachKm) }));
});

route('GET', '/api/appeals/drafts', ({ req }) => {
  authorize(principal(req), 'read');
  // Shortfalls the transfer advisor could not close become draft donor appeals.
  // Red cells only: platelets need apheresis donors, which is a separate pathway.
  const open = donors.appeals('open');
  return currentAdvice()
    .alerts.filter((a) => a.component === 'RBC' && a.shortfall > 0)
    .filter((a) => !open.some((o) => o.siteId === a.siteId && o.bloodGroups.includes(a.bloodGroup)))
    .map((a) => {
      const draft = {
        siteId: a.siteId,
        siteName: siteById(a.siteId)?.name,
        bloodGroups: [a.bloodGroup],
        component: 'RBC' as Component,
        unitsNeeded: Math.max(a.shortfall, 2),
        urgency: (a.severity === 'critical' ? 'urgent' : 'routine') as Urgency,
        neededBy: new Date(Date.now() + (a.severity === 'critical' ? 2 : 7) * 86_400_000).toISOString(),
        note: a.message,
      };
      return { ...draft, reach: donors.reach(draft, config.donor.appealReachKm) };
    })
    .sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || b.unitsNeeded - a.unitsNeeded);
});

route('POST', '/api/appeals', async ({ req }) => {
  const p = principal(req);
  const b = await readJson(req);
  const siteId = String(b.siteId ?? p.siteId ?? '');
  if (!siteById(siteId)) throw new HttpError(400, 'unknown site');
  authorize(p, 'manage_appeals', siteId);
  const groups = Array.isArray(b.bloodGroups) ? b.bloodGroups.map((g: unknown) => oneOf(g, BLOOD_GROUPS, 'bloodGroup')) : [];
  if (!groups.length) throw new HttpError(400, 'at least one blood group');
  const units = Number(b.unitsNeeded);
  if (!Number.isInteger(units) || units < 1 || units > 500) throw new HttpError(400, 'unitsNeeded must be 1-500');
  const appeal = donors.createAppeal({
    siteId,
    bloodGroups: groups,
    component: 'RBC',
    unitsNeeded: units,
    urgency: oneOf(b.urgency ?? 'routine', ['routine', 'urgent', 'emergency'] as const, 'urgency'),
    neededBy: b.neededBy ? new Date(b.neededBy).toISOString() : new Date(Date.now() + 7 * 86_400_000).toISOString(),
    note: String(b.note ?? '').slice(0, 280),
    createdBy: p.sub,
    source: b.source === 'ai_draft' ? 'ai_draft' : 'staff',
  });
  return { ...appeal, reach: donors.reach(appeal, config.donor.appealReachKm) };
});

route('POST', '/api/appeals/:id/close', ({ req, params }) => {
  const p = principal(req);
  const a = donors.appeal(params[0]);
  if (!a) throw new HttpError(404, 'unknown appeal');
  authorize(p, 'manage_appeals', a.siteId);
  donors.closeAppeal(a.id);
  return { ok: true };
});

route('GET', '/api/pledges', ({ req, url }) => {
  const p = principal(req);
  authorize(p, 'read');
  const siteId = url.searchParams.get('siteId') ?? p.siteId ?? undefined;
  return donors.pledges({ siteId, status: url.searchParams.get('status') ?? 'pledged' }).map((pl) => {
    const d = donors.get(pl.donorId);
    // Staff see what they need to receive the donor, nothing more.
    return { ...pledgeView(pl), donorName: d?.name, donorBloodGroup: d?.bloodGroup, groupVerified: d?.groupVerified };
  });
});

route('POST', '/api/pledges/:id/checkin', async ({ req, params }) => {
  const p = principal(req);
  const pl = donors.getPledge(params[0]);
  if (!pl) throw new HttpError(404, 'unknown pledge');
  authorize(p, 'checkin', pl.siteId);
  if (pl.status !== 'pledged') throw new HttpError(409, `pledge is ${pl.status}`);
  const b = await readJson(req);
  const donor = donors.get(pl.donorId)!;
  if (b.outcome === 'deferred') {
    // e.g. low haemoglobin, recent illness: recorded, donor told when to come back.
    donors.setPledgeStatus(pl.id, 'deferred');
    return { ok: true, status: 'deferred' };
  }
  const bloodGroup = b.bloodGroup ? oneOf(b.bloodGroup, BLOOD_GROUPS, 'bloodGroup') : donor.bloodGroup;
  if (bloodGroup === 'unknown') throw new HttpError(400, 'blood group must be typed at the site before collection');
  const now = new Date();
  const yy = now.toISOString().slice(2, 4);
  let din = '';
  do din = `X9999${yy}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}-RBC`;
  while (store.unit(din));
  const event = store.append({
    din,
    type: 'COLLECTED',
    siteId: pl.siteId,
    actor: p.sub,
    at: now.toISOString(),
    payload: {
      component: 'RBC',
      bloodGroup,
      donorRef: donor.id,
      appealId: pl.appealId,
      expiresAt: new Date(now.getTime() + config.components.RBC.shelfLifeDays * 86_400_000).toISOString(),
    },
  });
  donors.setPledgeStatus(pl.id, 'donated', din);
  donors.register({ ...donor, bloodGroup, groupVerified: true, lastDonationAt: now.toISOString() });
  return { ok: true, status: 'donated', din, event };
});

// HL7 FHIR R4 read-only facade.
route('GET', '/fhir/metadata', () => ({
  resourceType: 'CapabilityStatement',
  status: 'draft',
  kind: 'instance',
  fhirVersion: '4.0.1',
  format: ['json'],
  rest: [
    {
      mode: 'server',
      resource: [
        { type: 'BiologicallyDerivedProduct', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'status', type: 'token' }, { name: 'location', type: 'token' }] },
        { type: 'Provenance', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'target', type: 'reference' }] },
      ],
    },
  ],
}));

route('GET', '/fhir/BiologicallyDerivedProduct/:id', ({ req, params }) => {
  authorize(principal(req), 'read');
  const u = store.unit(decodeURIComponent(params[0]));
  if (!u) throw new HttpError(404, 'not found');
  return toBiologicallyDerivedProduct(u, config);
});

route('GET', '/fhir/BiologicallyDerivedProduct', ({ req, url }) => {
  authorize(principal(req), 'read');
  const status = url.searchParams.get('status');
  const units = store.units({
    siteId: url.searchParams.get('location') ?? undefined,
    status: status === 'available' ? 'available' : undefined,
    limit: Math.min(Number(url.searchParams.get('_count') ?? 50), 500),
  });
  return bundle(units.map((u) => toBiologicallyDerivedProduct(u, config)));
});

route('GET', '/fhir/Provenance', ({ req, url }) => {
  authorize(principal(req), 'read');
  const target = (url.searchParams.get('target') ?? '').replace('BiologicallyDerivedProduct/', '');
  return bundle(store.events(target).map(toProvenance));
});

// ---------- static files ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const publicDir = join(ROOT, 'public');
  const file = normalize(join(publicDir, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(publicDir)) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(await readFile(file));
  return true;
}

// ---------- server ----------

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const out = await r.handler({ req, url, params: m.slice(1) });
      return send(res, 200, out, url.pathname.startsWith('/fhir') ? 'application/fhir+json' : 'application/json');
    }
    if (req.method === 'GET' && (await serveStatic(res, url.pathname))) return;
    send(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof RejectedError ? 409 : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return void res.end();
    send(res, status, { error: status === 500 ? 'internal error' : (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`ABBIS slice node "${NODE_ID}" on http://localhost:${PORT}${PEER_URL ? `, syncing with ${PEER_URL}` : ''}`);
});
