import { BLOOD_GROUPS, COMPONENTS } from '../domain/types.ts';
import type { BloodGroup, Component, Site } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import type { Config } from '../config.ts';

/**
 * Discrete-event simulator that produces a realistic, fully synthetic history
 * by driving the real Store API (so every unit has a valid event trail).
 * No real donor, patient or facility data is used or implied.
 *
 * Patterns baked in so the AI has something real to find:
 *  - weekday demand peaks (elective surgery) and quieter weekends
 *  - one hospital with steadily growing demand
 *  - occasional mass-casualty spikes
 *  - a donor-supply dip while schools are closed (school drives are a large
 *    share of collections in many African blood services)
 *  - a remote hospital that only receives deliveries twice a week
 *  - a hospital that over-orders platelets, which then expire
 */

export const SITES: Site[] = [
  { id: 'CENTRE-1', name: 'Central Regional Blood Centre', type: 'blood_centre', region: 'Central', lat: -1.2921, lon: 36.8219 },
  { id: 'HOSP-ALPHA', name: 'Hospital Alpha', type: 'hospital', region: 'Central', lat: -1.3, lon: 36.8 },
  { id: 'HOSP-BETA', name: 'Hospital Beta', type: 'hospital', region: 'Rift', lat: -0.3031, lon: 36.08 },
  { id: 'HOSP-GAMMA', name: 'Hospital Gamma', type: 'hospital', region: 'Lake', lat: -0.0917, lon: 34.768 },
  { id: 'HOSP-DELTA', name: 'Hospital Delta', type: 'hospital', region: 'Eastern', lat: -1.5177, lon: 37.2634 },
];

interface HospitalProfile {
  rbcPerDay: number;
  growthPerDay: number; // multiplicative
  deliveryDays: number[] | null; // null = every day
  stockTargetDays: Record<Component, number>;
}

const PROFILES: Record<string, HospitalProfile> = {
  'HOSP-ALPHA': { rbcPerDay: 18, growthPerDay: 0, deliveryDays: null, stockTargetDays: { RBC: 4, PLT: 2, FFP: 6 } },
  'HOSP-BETA': { rbcPerDay: 9, growthPerDay: 0, deliveryDays: null, stockTargetDays: { RBC: 4, PLT: 6, FFP: 6 } },
  'HOSP-GAMMA': { rbcPerDay: 10, growthPerDay: 0.004, deliveryDays: null, stockTargetDays: { RBC: 4, PLT: 2, FFP: 6 } },
  'HOSP-DELTA': { rbcPerDay: 5, growthPerDay: 0, deliveryDays: [1, 4], stockTargetDays: { RBC: 6, PLT: 3, FFP: 8 } },
};

const COMPONENT_RATIO: Record<Component, number> = { RBC: 1, PLT: 0.3, FFP: 0.4 };
const WEEKDAY = [0.6, 1.15, 1.15, 1.1, 1.1, 1.1, 0.8]; // Sun..Sat
const DAY_MS = 86_400_000;

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda: number, rand: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian(rand)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
}

function pick<T extends string>(weights: Record<T, number>, rand: () => number): T {
  const r = rand();
  let acc = 0;
  for (const [k, w] of Object.entries(weights) as [T, number][]) {
    acc += w;
    if (r <= acc) return k;
  }
  return Object.keys(weights)[0] as T;
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface GenerateOptions {
  days: number;
  endDay: string; // YYYY-MM-DD, exclusive (usually today)
  seed: number;
}

export function generate(store: Store, config: Config, opts: GenerateOptions): { units: number; events: number } {
  const rand = rng(opts.seed);
  for (const s of SITES) store.upsertSite(s);
  const centre = SITES[0];
  const hospitals = SITES.slice(1);
  const startMs = Date.parse(opts.endDay + 'T00:00:00Z') - opts.days * DAY_MS;
  const yy = opts.endDay.slice(2, 4);
  let seq = 0;
  let eventCount = 0;
  const rec = (e: Parameters<Store['append']>[0]) => {
    store.append(e);
    eventCount++;
  };
  const quarantine: string[] = [];
  const recentDemand = new Map<string, number[]>(); // site|comp|group -> daily requested (last 14)
  const inTransit: { din: string; to: string; key: string; arriveMs: number }[] = [];
  const spikeDays = new Set([Math.floor(opts.days * 0.3), Math.floor(opts.days * 0.72)]);
  // School holidays: supply drops to 60% for 3 weeks ending 10 days before the end.
  const dipStart = opts.days - 31;
  const dipEnd = opts.days - 10;

  for (let d = 0; d < opts.days; d++) {
    const dayMs = startMs + d * DAY_MS;
    const day = iso(dayMs).slice(0, 10);
    const dow = new Date(dayMs).getUTCDay();

    store.transaction(() => {
      // 1. Receive yesterday's dispatches.
      for (let i = inTransit.length - 1; i >= 0; i--) {
        const t = inTransit[i];
        if (t.arriveMs <= dayMs + 8 * 3600_000) {
          rec({ din: t.din, type: 'RECEIVED', siteId: t.to, actor: `inv-${t.to}`, at: iso(dayMs + 8 * 3600_000) });
          inTransit.splice(i, 1);
        }
      }

      // 2. Test yesterday's collections.
      while (quarantine.length) {
        const din = quarantine.pop()!;
        const result = rand() < 0.025 ? 'reactive' : 'negative';
        rec({
          din,
          type: 'TESTED',
          siteId: centre.id,
          actor: 'lab-CENTRE-1',
          at: iso(dayMs + 10 * 3600_000),
          payload: { result, panel: config.ttiPanel },
        });
      }

      // 3. Collections at the blood centre (donor drives mostly on weekdays).
      const supply = (d >= dipStart && d < dipEnd ? 0.6 : 1) * (dow === 0 ? 0.3 : dow === 6 ? 0.7 : 1.1);
      const donations = poisson(52 * supply, rand);
      for (let i = 0; i < donations; i++) {
        const bloodGroup = pick(config.bloodGroupShare, rand);
        const donation = `X9999${yy}${String(++seq).padStart(6, '0')}`;
        const collectedMs = dayMs + (9 + rand() * 6) * 3600_000;
        const made: Component[] = ['RBC'];
        if (rand() < 0.3) made.push('PLT');
        if (rand() < 0.5) made.push('FFP');
        for (const component of made) {
          const din = `${donation}-${component}`;
          rec({
            din,
            type: 'COLLECTED',
            siteId: centre.id,
            actor: 'lab-CENTRE-1',
            at: iso(collectedMs),
            payload: {
              component,
              bloodGroup,
              donorRef: `D-${(seq * 2654435761 >>> 0).toString(36)}`,
              expiresAt: iso(collectedMs + config.components[component].shelfLifeDays * DAY_MS),
            },
          });
          quarantine.push(din);
        }
      }

      // 4. Hospital demand: issue FEFO, log unmet requests.
      for (const h of hospitals) {
        const p = PROFILES[h.id];
        const spike = spikeDays.has(d) && h.id === 'HOSP-ALPHA' ? 2.2 : 1;
        const level = p.rbcPerDay * WEEKDAY[dow] * Math.pow(1 + p.growthPerDay, d) * spike;
        for (const component of COMPONENTS) {
          for (const bloodGroup of BLOOD_GROUPS) {
            const requested = poisson(level * COMPONENT_RATIO[component] * config.bloodGroupShare[bloodGroup], rand);
            const k = `${h.id}|${component}|${bloodGroup}`;
            const hist = recentDemand.get(k) ?? [];
            hist.push(requested);
            if (hist.length > 14) hist.shift();
            recentDemand.set(k, hist);
            const asOf = iso(dayMs + 21 * 3600_000); // end of the issuing window
            const stock = requested ? store.available(h.id, component, bloodGroup, asOf) : [];
            const fulfilled = Math.min(requested, stock.length);
            for (let i = 0; i < fulfilled; i++) {
              const u = stock[i];
              const patientRef = `P-${Math.floor(rand() * 1e9).toString(36)}`;
              const t = dayMs + (11 + rand() * 10) * 3600_000;
              rec({ din: u.din, type: 'ISSUED', siteId: h.id, actor: `clin-${h.id}`, at: iso(t), payload: { patientRef } });
              if (rand() < 0.97) {
                rec({ din: u.din, type: 'TRANSFUSED', siteId: h.id, actor: `clin-${h.id}`, at: iso(t + 1800_000), payload: {} });
              } else {
                rec({
                  din: u.din,
                  type: 'RETURNED',
                  siteId: h.id,
                  actor: `clin-${h.id}`,
                  at: iso(t + 3600_000),
                  payload: { coldChainOk: rand() < 0.9 },
                });
              }
            }
            store.recordDemand(h.id, bloodGroup, component, day, requested, fulfilled);
          }
        }
      }

      // 5. Replenishment from the centre (order-up-to policy, FEFO from centre stock).
      for (const h of hospitals) {
        const p = PROFILES[h.id];
        if (p.deliveryDays && !p.deliveryDays.includes(dow)) continue;
        for (const component of COMPONENTS) {
          for (const bloodGroup of BLOOD_GROUPS) {
            const hist = recentDemand.get(`${h.id}|${component}|${bloodGroup}`) ?? [];
            const avg = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : 0;
            const target = Math.ceil(avg * p.stockTargetDays[component]);
            const at = iso(dayMs + 16 * 3600_000);
            const onHand =
              store.available(h.id, component, bloodGroup, at).length + inTransit.filter((t) => t.to === h.id && t.key === `${component}|${bloodGroup}`).length;
            const want = target - onHand;
            if (want <= 0) continue;
            const centreStock = store
              .available(centre.id, component, bloodGroup, at)
              .filter((u) => Date.parse(u.expiresAt) - dayMs > 2 * DAY_MS);
            for (const u of centreStock.slice(0, want)) {
              rec({ din: u.din, type: 'DISPATCHED', siteId: centre.id, actor: 'inv-CENTRE-1', at, payload: { toSiteId: h.id } });
              inTransit.push({ din: u.din, to: h.id, key: `${component}|${bloodGroup}`, arriveMs: dayMs + DAY_MS });
            }
          }
        }
      }

      // 6. End of day: discard anything that expires before tomorrow starts.
      const endOfDay = iso(dayMs + 23.5 * 3600_000);
      const cutoff = iso(dayMs + DAY_MS);
      const expiring = store.db
        .prepare(`SELECT din, site_id FROM units WHERE status IN ('available', 'quarantine') AND expires_at <= ?`)
        .all(cutoff) as { din: string; site_id: string }[];
      for (const u of expiring) {
        rec({ din: u.din, type: 'DISCARDED', siteId: u.site_id, actor: `inv-${u.site_id}`, at: endOfDay, payload: { reason: 'expired' } });
      }
    });
  }
  return { units: seq, events: eventCount };
}

// ---------- donors and appeals ----------

const FIRST = ['Amina', 'Brian', 'Chebet', 'David', 'Esther', 'Faith', 'George', 'Halima', 'Ian', 'Joy', 'Kevin', 'Lilian', 'Moses', 'Njeri', 'Otieno', 'Purity', 'Rashid', 'Sharon', 'Tom', 'Wanjiru'];
const LAST = ['A.', 'B.', 'C.', 'K.', 'M.', 'N.', 'O.', 'W.'];

/** Synthetic donors scattered around the sites, plus a few staff-published appeals. */
export function generateDonors(
  store: Store,
  donors: import('../donor/donors.ts').Donors,
  config: Config,
  opts: { count: number; seed: number; now?: Date },
): { donors: number; appeals: number } {
  const rand = rng(opts.seed + 1);
  const now = opts.now ?? new Date();
  // Two hospitals run their own donor clinics; the blood centre always collects.
  donors.setCollects('HOSP-ALPHA', true);
  donors.setCollects('HOSP-GAMMA', true);
  for (let i = 0; i < opts.count; i++) {
    const home = SITES[Math.floor(rand() * SITES.length)];
    const last = rand() < 0.35 ? null : new Date(now.getTime() - Math.floor(rand() * 200) * DAY_MS).toISOString();
    donors.register({
      id: `DNR-${String(i + 1).padStart(4, '0')}`,
      name: `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`,
      bloodGroup: rand() < 0.08 ? 'unknown' : pick(config.bloodGroupShare, rand),
      groupVerified: last !== null,
      lat: home.lat + gaussian(rand) * 0.12,
      lon: home.lon + gaussian(rand) * 0.12,
      lastDonationAt: last,
      smsConsent: rand() < 0.7,
      createdAt: new Date(now.getTime() - Math.floor(rand() * 400) * DAY_MS).toISOString(),
    });
  }
  const inDays = (d: number) => new Date(now.getTime() + d * DAY_MS).toISOString();
  const seeded = [
    { siteId: 'HOSP-ALPHA', bloodGroups: ['O-'], unitsNeeded: 6, urgency: 'emergency', neededBy: inDays(1), note: 'Road traffic accident: O negative needed today.' },
    { siteId: 'HOSP-GAMMA', bloodGroups: ['O+'], unitsNeeded: 20, urgency: 'urgent', neededBy: inDays(3), note: 'Maternity ward demand is rising. Walk-ins welcome 8am–5pm.' },
    { siteId: 'CENTRE-1', bloodGroups: ['B+', 'A+'], unitsNeeded: 30, urgency: 'routine', neededBy: inDays(10), note: 'Stocks are low after the school holidays.' },
  ] as const;
  for (const a of seeded) donors.createAppeal({ ...a, bloodGroups: [...a.bloodGroups], component: 'RBC', createdBy: `inv-${a.siteId}`, source: 'staff' });
  return { donors: opts.count, appeals: seeded.length };
}
