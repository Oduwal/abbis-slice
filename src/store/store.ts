import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { apply, replay, validate } from '../domain/lifecycle.ts';
import { HLC } from '../sync/hlc.ts';
import type { BloodGroup, Component, Conflict, Site, UnitEvent, UnitState } from '../domain/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, region TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL
);
-- Append-only event log. seq is local insertion order (used as a sync cursor);
-- hlc is the global causal order used to build state.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  din TEXT NOT NULL,
  type TEXT NOT NULL,
  site_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  hlc TEXT NOT NULL,
  at TEXT NOT NULL,
  origin TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_din ON events (din, hlc);
-- Materialised projection of the event log. Always rebuildable.
CREATE TABLE IF NOT EXISTS units (
  din TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  blood_group TEXT NOT NULL,
  status TEXT NOT NULL,
  site_id TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  patient_ref TEXT,
  destination_site_id TEXT,
  discard_reason TEXT
);
CREATE INDEX IF NOT EXISTS units_stock ON units (site_id, status, component, blood_group, expires_at);
CREATE TABLE IF NOT EXISTS conflicts (
  event_id TEXT PRIMARY KEY,
  din TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_by TEXT,
  resolution TEXT
);
-- Demand = what clinicians asked for, including requests that could not be met.
-- Forecasting on issues alone would learn the stock-outs as "low demand".
CREATE TABLE IF NOT EXISTS demand (
  site_id TEXT NOT NULL, blood_group TEXT NOT NULL, component TEXT NOT NULL, day TEXT NOT NULL,
  requested INTEGER NOT NULL DEFAULT 0, fulfilled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, blood_group, component, day)
);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT
);
CREATE TABLE IF NOT EXISTS peers (
  url TEXT PRIMARY KEY,
  pulled_seq INTEGER NOT NULL DEFAULT 0,
  pushed_seq INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_error TEXT
);
`;

export interface NewEvent {
  id?: string;
  din: string;
  type: UnitEvent['type'];
  siteId: string;
  actor: string;
  at?: string;
  payload?: Record<string, unknown>;
}

export class RejectedError extends Error {
  readonly status = 409;
}

interface EventRow {
  seq: number;
  id: string;
  din: string;
  type: string;
  site_id: string;
  actor: string;
  hlc: string;
  at: string;
  origin: string;
  payload: string;
}

function rowToEvent(r: EventRow): UnitEvent {
  return {
    id: r.id,
    din: r.din,
    type: r.type as UnitEvent['type'],
    siteId: r.site_id,
    actor: r.actor,
    hlc: r.hlc,
    at: r.at,
    origin: r.origin,
    payload: JSON.parse(r.payload),
  };
}

interface UnitRow {
  din: string;
  component: string;
  blood_group: string;
  status: string;
  site_id: string;
  collected_at: string;
  expires_at: string;
  last_event_at: string;
  patient_ref: string | null;
  destination_site_id: string | null;
  discard_reason: string | null;
}

function rowToUnit(r: UnitRow): UnitState {
  return {
    din: r.din,
    component: r.component as Component,
    bloodGroup: r.blood_group as BloodGroup,
    status: r.status as UnitState['status'],
    siteId: r.site_id,
    collectedAt: r.collected_at,
    expiresAt: r.expires_at,
    lastEventAt: r.last_event_at,
    patientRef: r.patient_ref,
    destinationSiteId: r.destination_site_id,
    discardReason: r.discard_reason,
  };
}

export class Store {
  readonly db: DatabaseSync;
  readonly nodeId: string;
  readonly clock: HLC;

  constructor(path: string, nodeId: string, now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.nodeId = nodeId;
    this.clock = new HLC(nodeId, now);
    const last = this.db.prepare('SELECT MAX(hlc) AS h FROM events').get() as { h: string | null };
    if (last.h) this.clock.receive(last.h);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- sites ----------

  upsertSite(s: Site): void {
    this.db
      .prepare('INSERT OR REPLACE INTO sites (id, name, type, region, lat, lon) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, s.name, s.type, s.region, s.lat, s.lon);
  }

  sites(): Site[] {
    return this.db.prepare('SELECT * FROM sites ORDER BY type, id').all() as unknown as Site[];
  }

  site(id: string): Site | undefined {
    return this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as unknown as Site | undefined;
  }

  // ---------- writing events ----------

  /**
   * Record a new event that happened at this node. Invalid actions are refused
   * up front (the user gets an error). Idempotent on event id, so a client that
   * retries after a dropped connection does not create duplicates.
   */
  append(input: NewEvent): UnitEvent {
    if (input.id) {
      const existing = this.db.prepare('SELECT * FROM events WHERE id = ?').get(input.id) as EventRow | undefined;
      if (existing) return rowToEvent(existing);
    }
    const at = input.at ?? new Date().toISOString();
    const event: UnitEvent = {
      id: input.id ?? randomUUID(),
      din: input.din,
      type: input.type,
      siteId: input.siteId,
      actor: input.actor,
      at,
      hlc: this.clock.tick(Date.parse(at)),
      origin: this.nodeId,
      payload: input.payload ?? {},
    };
    const current = this.unit(event.din) ?? null;
    const reason = validate(current, event);
    if (reason) throw new RejectedError(`${event.type} ${event.din}: ${reason}`);
    this.insertEvent(event);
    this.writeUnit(apply(current, event));
    return event;
  }

  /**
   * Merge events from a peer. Every event is kept (the log is the audit trail);
   * affected units are rebuilt in HLC order and anything that no longer fits
   * becomes a conflict.
   */
  importEvents(events: UnitEvent[]): { imported: number; duplicates: number; conflicts: number } {
    let imported = 0;
    let duplicates = 0;
    const touched = new Set<string>();
    this.transaction(() => {
      for (const e of events) {
        this.clock.receive(e.hlc);
        if (this.insertEvent(e)) {
          imported++;
          touched.add(e.din);
        } else duplicates++;
      }
    });
    let conflicts = 0;
    this.transaction(() => {
      for (const din of touched) conflicts += this.reproject(din);
    });
    return { imported, duplicates, conflicts };
  }

  private insertEvent(e: UnitEvent): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (id, din, type, site_id, actor, hlc, at, origin, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.din, e.type, e.siteId, e.actor, e.hlc, e.at, e.origin, JSON.stringify(e.payload));
    return Number(res.changes) > 0;
  }

  /** Rebuild one unit from its full history. Returns the number of open conflicts. */
  reproject(din: string): number {
    const { state, rejected } = replay(this.events(din));
    if (state) this.writeUnit(state);
    const rejectedIds = new Set(rejected.map((r) => r.event.id));
    for (const c of this.db.prepare('SELECT event_id FROM conflicts WHERE din = ? AND resolved_by IS NULL').all(din) as {
      event_id: string;
    }[]) {
      if (!rejectedIds.has(c.event_id)) this.db.prepare('DELETE FROM conflicts WHERE event_id = ?').run(c.event_id);
    }
    const now = new Date().toISOString();
    for (const r of rejected) {
      this.db
        .prepare('INSERT OR IGNORE INTO conflicts (event_id, din, reason, detected_at) VALUES (?, ?, ?, ?)')
        .run(r.event.id, din, `${r.event.type} at ${r.event.siteId} by ${r.event.actor}: ${r.reason}`, now);
    }
    return rejected.length;
  }

  private writeUnit(u: UnitState): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO units (din, component, blood_group, status, site_id, collected_at, expires_at,
          last_event_at, patient_ref, destination_site_id, discard_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.din,
        u.component,
        u.bloodGroup,
        u.status,
        u.siteId,
        u.collectedAt,
        u.expiresAt,
        u.lastEventAt,
        u.patientRef,
        u.destinationSiteId,
        u.discardReason,
      );
  }

  // ---------- reading ----------

  unit(din: string): UnitState | undefined {
    const r = this.db.prepare('SELECT * FROM units WHERE din = ?').get(din) as UnitRow | undefined;
    return r ? rowToUnit(r) : undefined;
  }

  events(din: string): UnitEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE din = ? ORDER BY hlc, id').all(din) as unknown as EventRow[]).map(
      rowToEvent,
    );
  }

  units(filter: { siteId?: string; status?: string; component?: string; bloodGroup?: string; limit?: number } = {}): UnitState[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.siteId) (where.push('site_id = ?'), args.push(filter.siteId));
    if (filter.status) (where.push('status = ?'), args.push(filter.status));
    if (filter.component) (where.push('component = ?'), args.push(filter.component));
    if (filter.bloodGroup) (where.push('blood_group = ?'), args.push(filter.bloodGroup));
    const sql = `SELECT * FROM units ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY expires_at LIMIT ?`;
    args.push(filter.limit ?? 500);
    return (this.db.prepare(sql).all(...args) as unknown as UnitRow[]).map(rowToUnit);
  }

  /** Usable stock at a site, soonest expiry first (FEFO). */
  available(siteId: string, component: Component, bloodGroup: BloodGroup, asOf: string): UnitState[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM units WHERE site_id = ? AND component = ? AND blood_group = ?
           AND status = 'available' AND expires_at > ? ORDER BY expires_at`,
        )
        .all(siteId, component, bloodGroup, asOf) as unknown as UnitRow[]
    ).map(rowToUnit);
  }

  inventorySummary(asOf: string): { siteId: string; component: string; bloodGroup: string; status: string; n: number }[] {
    return this.db
      .prepare(
        `SELECT site_id AS siteId, component, blood_group AS bloodGroup, status, COUNT(*) AS n FROM units
         WHERE status IN ('available', 'reserved', 'quarantine', 'in_transit') AND expires_at > ?
         GROUP BY site_id, component, blood_group, status`,
      )
      .all(asOf) as never;
  }

  conflicts(includeResolved = false): (Conflict & { resolvedBy: string | null; resolution: string | null })[] {
    return this.db
      .prepare(
        `SELECT event_id AS eventId, din, reason, detected_at AS detectedAt, resolved_by AS resolvedBy, resolution
         FROM conflicts ${includeResolved ? '' : 'WHERE resolved_by IS NULL'} ORDER BY detected_at DESC`,
      )
      .all() as never;
  }

  resolveConflict(eventId: string, by: string, resolution: string): boolean {
    const r = this.db
      .prepare('UPDATE conflicts SET resolved_by = ?, resolution = ? WHERE event_id = ? AND resolved_by IS NULL')
      .run(by, resolution, eventId);
    return Number(r.changes) > 0;
  }

  // ---------- demand ----------

  recordDemand(siteId: string, bloodGroup: BloodGroup, component: Component, day: string, requested: number, fulfilled: number): void {
    this.db
      .prepare(
        `INSERT INTO demand (site_id, blood_group, component, day, requested, fulfilled) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (site_id, blood_group, component, day)
         DO UPDATE SET requested = requested + excluded.requested, fulfilled = fulfilled + excluded.fulfilled`,
      )
      .run(siteId, bloodGroup, component, day, requested, fulfilled);
  }

  demandSeries(siteId: string, bloodGroup: string, component: string): { day: string; requested: number; fulfilled: number }[] {
    return this.db
      .prepare('SELECT day, requested, fulfilled FROM demand WHERE site_id = ? AND blood_group = ? AND component = ? ORDER BY day')
      .all(siteId, bloodGroup, component) as never;
  }

  // ---------- sync ----------

  exportSince(seq: number, limit = 1000): { events: UnitEvent[]; lastSeq: number; more: boolean } {
    const rows = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit + 1) as unknown as EventRow[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return { events: page.map(rowToEvent), lastSeq: page.length ? page[page.length - 1].seq : seq, more };
  }

  headSeq(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get() as { s: number }).s;
  }

  peer(url: string): { url: string; pulled_seq: number; pushed_seq: number; last_sync_at: string | null; last_error: string | null } {
    this.db.prepare('INSERT OR IGNORE INTO peers (url) VALUES (?)').run(url);
    return this.db.prepare('SELECT * FROM peers WHERE url = ?').get(url) as never;
  }

  updatePeer(url: string, fields: { pulled_seq?: number; pushed_seq?: number; last_error?: string | null }): void {
    const p = this.peer(url);
    this.db
      .prepare('UPDATE peers SET pulled_seq = ?, pushed_seq = ?, last_sync_at = ?, last_error = ? WHERE url = ?')
      .run(
        fields.pulled_seq ?? p.pulled_seq,
        fields.pushed_seq ?? p.pushed_seq,
        new Date().toISOString(),
        fields.last_error === undefined ? null : fields.last_error,
        url,
      );
  }

  stats(): Record<string, number> {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      events: one('SELECT COUNT(*) AS n FROM events'),
      units: one('SELECT COUNT(*) AS n FROM units'),
      openConflicts: one('SELECT COUNT(*) AS n FROM conflicts WHERE resolved_by IS NULL'),
      sites: one('SELECT COUNT(*) AS n FROM sites'),
    };
  }
}
