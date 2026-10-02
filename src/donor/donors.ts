import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.ts';
import type { BloodGroup, Component, Site } from '../domain/types.ts';
import { haversineKm } from '../ai/advisor.ts';

/**
 * Donor engagement: hospitals and blood banks publish appeals ("we need O-"),
 * donors see the ones their blood can serve, pick where to donate (the
 * requesting facility if it collects, or the nearest collection site) and
 * pledge a slot. Check-in at the site creates the unit in the traceability log.
 *
 * Privacy by design: donors never see patient data; an appeal names a
 * facility, a blood group and a quantity. Donor location is stored rounded to
 * ~1 km and only used for distance.
 */

export interface Donor {
  id: string;
  name: string;
  bloodGroup: BloodGroup | 'unknown';
  groupVerified: boolean; // true once a lab has typed a donation
  lat: number | null;
  lon: number | null;
  lastDonationAt: string | null;
  phone: string | null;
  smsConsent: boolean;
  createdAt: string;
}

export type Urgency = 'routine' | 'urgent' | 'emergency';

export interface Appeal {
  id: string;
  siteId: string;
  bloodGroups: BloodGroup[];
  component: Component;
  unitsNeeded: number;
  urgency: Urgency;
  neededBy: string;
  note: string;
  status: 'open' | 'closed';
  createdBy: string;
  createdAt: string;
  source: 'staff' | 'ai_draft';
}

export interface Pledge {
  id: string;
  donorId: string;
  appealId: string | null;
  siteId: string;
  slot: string; // ISO start time
  status: 'pledged' | 'donated' | 'cancelled' | 'deferred';
  createdAt: string;
  din: string | null;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS donors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, blood_group TEXT NOT NULL, group_verified INTEGER NOT NULL DEFAULT 0,
  lat REAL, lon REAL, last_donation_at TEXT, phone TEXT, sms_consent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL, blood_groups TEXT NOT NULL, component TEXT NOT NULL,
  units_needed INTEGER NOT NULL, urgency TEXT NOT NULL, needed_by TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'staff'
);
CREATE TABLE IF NOT EXISTS pledges (
  id TEXT PRIMARY KEY, donor_id TEXT NOT NULL, appeal_id TEXT, site_id TEXT NOT NULL, slot TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, din TEXT
);
CREATE INDEX IF NOT EXISTS pledges_appeal ON pledges (appeal_id, status);
CREATE INDEX IF NOT EXISTS pledges_donor ON pledges (donor_id, status);
`;

/**
 * Red cell compatibility: which donor groups can give to a recipient group.
 * Appeals are for whole blood / red cells, which is what a walk-in donor gives.
 */
export function compatibleDonors(recipient: BloodGroup): BloodGroup[] {
  const abo = recipient.replace(/[+-]/, '');
  const rhPos = recipient.endsWith('+');
  const aboOk: Record<string, string[]> = { O: ['O'], A: ['A', 'O'], B: ['B', 'O'], AB: ['AB', 'A', 'B', 'O'] };
  const out: BloodGroup[] = [];
  for (const a of aboOk[abo]) {
    out.push(`${a}-` as BloodGroup);
    if (rhPos) out.push(`${a}+` as BloodGroup);
  }
  return out;
}

export function matchLevel(donor: BloodGroup | 'unknown', appeal: BloodGroup[]): 'exact' | 'compatible' | 'unknown' | 'none' {
  if (donor === 'unknown') return 'unknown';
  if (appeal.includes(donor)) return 'exact';
  if (appeal.some((g) => compatibleDonors(g).includes(donor))) return 'compatible';
  return 'none';
}

const round1km = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

export class Donors {
  private readonly store: Store;
  readonly minDaysBetween: number;

  constructor(store: Store, minDaysBetween = 84) {
    this.store = store;
    this.minDaysBetween = minDaysBetween;
    store.db.exec(SCHEMA);
    // Sites gained a "collects donations" flag with the donor module.
    const cols = store.db.prepare('PRAGMA table_info(sites)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'collects')) store.db.exec('ALTER TABLE sites ADD COLUMN collects INTEGER NOT NULL DEFAULT 0');
    store.db.exec("UPDATE sites SET collects = 1 WHERE type = 'blood_centre'");
  }

  // ---------- donors ----------

  register(d: Partial<Donor> & { name: string; bloodGroup: Donor['bloodGroup'] }): Donor {
    const donor: Donor = {
      id: d.id ?? `DNR-${randomUUID().slice(0, 8)}`,
      name: d.name,
      bloodGroup: d.bloodGroup,
      groupVerified: d.groupVerified ?? false,
      lat: round1km(d.lat),
      lon: round1km(d.lon),
      lastDonationAt: d.lastDonationAt ?? null,
      phone: d.phone ?? null,
      smsConsent: d.smsConsent ?? false,
      createdAt: d.createdAt ?? new Date().toISOString(),
    };
    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO donors (id, name, blood_group, group_verified, lat, lon, last_donation_at, phone, sms_consent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(donor.id, donor.name, donor.bloodGroup, donor.groupVerified ? 1 : 0, donor.lat, donor.lon, donor.lastDonationAt, donor.phone, donor.smsConsent ? 1 : 0, donor.createdAt);
    return donor;
  }

  update(id: string, patch: Partial<Pick<Donor, 'lat' | 'lon' | 'bloodGroup' | 'phone' | 'smsConsent' | 'lastDonationAt'>>): Donor {
    const cur = this.get(id);
    if (!cur) throw new Error('unknown donor');
    // A lab-verified blood group cannot be overwritten by self-report.
    const bloodGroup = cur.groupVerified ? cur.bloodGroup : (patch.bloodGroup ?? cur.bloodGroup);
    return this.register({ ...cur, ...patch, bloodGroup, lat: patch.lat ?? cur.lat, lon: patch.lon ?? cur.lon });
  }

  get(id: string): Donor | undefined {
    const r = this.store.db.prepare('SELECT * FROM donors WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? rowToDonor(r) : undefined;
  }

  all(limit = 50): Donor[] {
    return (this.store.db.prepare('SELECT * FROM donors ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, any>[]).map(rowToDonor);
  }

  eligibility(d: Donor, now = new Date()): { eligible: boolean; nextEligibleAt: string | null; reason: string } {
    if (!d.lastDonationAt) return { eligible: true, nextEligibleAt: null, reason: 'No recorded donation: final check happens at the donation site.' };
    const next = new Date(Date.parse(d.lastDonationAt) + this.minDaysBetween * 86_400_000);
    if (next <= now) return { eligible: true, nextEligibleAt: null, reason: `Last donation over ${this.minDaysBetween} days ago.` };
    return { eligible: false, nextEligibleAt: next.toISOString(), reason: `Your body needs ${this.minDaysBetween} days between whole blood donations.` };
  }

  // ---------- sites ----------

  collectionSites(): Site[] {
    return this.store.db.prepare('SELECT * FROM sites WHERE collects = 1').all() as unknown as Site[];
  }

  setCollects(siteId: string, collects: boolean) {
    this.store.db.prepare('UPDATE sites SET collects = ? WHERE id = ?').run(collects ? 1 : 0, siteId);
  }

  /** Where a donor can go for an appeal: the requesting site if it collects, plus collection sites by distance. */
  donationOptions(from: { lat: number; lon: number } | null, appealSiteId?: string) {
    const pt = from ? ({ lat: from.lat, lon: from.lon } as Site) : null;
    return this.collectionSites()
      .map((s) => ({ ...s, distanceKm: pt ? haversineKm(pt, s) : null, isRequester: s.id === appealSiteId }))
      .sort((a, b) => Number(b.isRequester) - Number(a.isRequester) || (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  }

  // ---------- appeals ----------

  createAppeal(a: Omit<Appeal, 'id' | 'createdAt' | 'status'> & { id?: string }): Appeal {
    const appeal: Appeal = { ...a, id: a.id ?? `APL-${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), status: 'open' };
    this.store.db
      .prepare(
        `INSERT INTO appeals (id, site_id, blood_groups, component, units_needed, urgency, needed_by, note, status, created_by, created_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(appeal.id, appeal.siteId, JSON.stringify(appeal.bloodGroups), appeal.component, appeal.unitsNeeded, appeal.urgency, appeal.neededBy, appeal.note, appeal.status, appeal.createdBy, appeal.createdAt, appeal.source);
    return appeal;
  }

  closeAppeal(id: string): boolean {
    return Number(this.store.db.prepare("UPDATE appeals SET status = 'closed' WHERE id = ? AND status = 'open'").run(id).changes) > 0;
  }

  appeal(id: string): Appeal | undefined {
    const r = this.store.db.prepare('SELECT * FROM appeals WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? rowToAppeal(r) : undefined;
  }

  appeals(status: 'open' | 'closed' | 'all' = 'open'): (Appeal & { pledged: number; donated: number })[] {
    const rows = this.store.db
      .prepare(`SELECT * FROM appeals ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY created_at DESC`)
      .all(...(status === 'all' ? [] : [status])) as Record<string, any>[];
    const counts = this.store.db.prepare(
      "SELECT SUM(status = 'pledged') AS pledged, SUM(status = 'donated') AS donated FROM pledges WHERE appeal_id = ?",
    );
    return rows.map((r) => {
      const c = counts.get(r.id) as { pledged: number | null; donated: number | null };
      return { ...rowToAppeal(r), pledged: c.pledged ?? 0, donated: c.donated ?? 0 };
    });
  }

  /** How many eligible, compatible donors live within `km` of the appeal's site: shown to staff before publishing. */
  reach(appeal: Pick<Appeal, 'siteId' | 'bloodGroups'>, km = 50): { exact: number; compatible: number } {
    const site = this.store.site(appeal.siteId);
    if (!site) return { exact: 0, compatible: 0 };
    let exact = 0;
    let compatible = 0;
    for (const r of this.store.db.prepare('SELECT * FROM donors WHERE lat IS NOT NULL').all() as Record<string, any>[]) {
      const d = rowToDonor(r);
      if (!this.eligibility(d).eligible) continue;
      if (haversineKm(site, { lat: d.lat!, lon: d.lon! } as Site) > km) continue;
      const m = matchLevel(d.bloodGroup, appeal.bloodGroups);
      if (m === 'exact') exact++;
      else if (m === 'compatible') compatible++;
    }
    return { exact, compatible };
  }

  // ---------- pledges ----------

  pledge(p: { donorId: string; appealId: string | null; siteId: string; slot: string }): Pledge {
    const donor = this.get(p.donorId);
    if (!donor) throw new Error('unknown donor');
    const el = this.eligibility(donor, new Date(p.slot));
    if (!el.eligible) throw new Error(`not yet eligible: ${el.reason} Next: ${el.nextEligibleAt?.slice(0, 10)}`);
    if (!this.collectionSites().some((s) => s.id === p.siteId)) throw new Error('that site does not collect donations');
    if (p.appealId) {
      const a = this.appeal(p.appealId);
      if (!a || a.status !== 'open') throw new Error('appeal is closed');
    }
    const active = this.store.db.prepare("SELECT COUNT(*) AS n FROM pledges WHERE donor_id = ? AND status = 'pledged'").get(p.donorId) as { n: number };
    if (active.n > 0) throw new Error('you already have an upcoming donation: cancel it first to choose another');
    const pledge: Pledge = { id: `PLG-${randomUUID().slice(0, 8)}`, ...p, status: 'pledged', createdAt: new Date().toISOString(), din: null };
    this.store.db
      .prepare('INSERT INTO pledges (id, donor_id, appeal_id, site_id, slot, status, created_at, din) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(pledge.id, pledge.donorId, pledge.appealId, pledge.siteId, pledge.slot, pledge.status, pledge.createdAt, null);
    return pledge;
  }

  pledges(filter: { donorId?: string; appealId?: string; siteId?: string; status?: string }): Pledge[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.donorId) (where.push('donor_id = ?'), args.push(filter.donorId));
    if (filter.appealId) (where.push('appeal_id = ?'), args.push(filter.appealId));
    if (filter.siteId) (where.push('site_id = ?'), args.push(filter.siteId));
    if (filter.status) (where.push('status = ?'), args.push(filter.status));
    return (
      this.store.db.prepare(`SELECT * FROM pledges ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY slot`).all(...args) as Record<string, any>[]
    ).map(rowToPledge);
  }

  getPledge(id: string): Pledge | undefined {
    const r = this.store.db.prepare('SELECT * FROM pledges WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? rowToPledge(r) : undefined;
  }

  setPledgeStatus(id: string, status: Pledge['status'], din: string | null = null) {
    this.store.db.prepare('UPDATE pledges SET status = ?, din = COALESCE(?, din) WHERE id = ?').run(status, din, id);
  }
}

function rowToDonor(r: Record<string, any>): Donor {
  return {
    id: r.id,
    name: r.name,
    bloodGroup: r.blood_group,
    groupVerified: !!r.group_verified,
    lat: r.lat,
    lon: r.lon,
    lastDonationAt: r.last_donation_at,
    phone: r.phone,
    smsConsent: !!r.sms_consent,
    createdAt: r.created_at,
  };
}

function rowToAppeal(r: Record<string, any>): Appeal {
  return {
    id: r.id,
    siteId: r.site_id,
    bloodGroups: JSON.parse(r.blood_groups),
    component: r.component,
    unitsNeeded: r.units_needed,
    urgency: r.urgency,
    neededBy: r.needed_by,
    note: r.note,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    source: r.source,
  };
}

function rowToPledge(r: Record<string, any>): Pledge {
  return { id: r.id, donorId: r.donor_id, appealId: r.appeal_id, siteId: r.site_id, slot: r.slot, status: r.status, createdAt: r.created_at, din: r.din };
}
