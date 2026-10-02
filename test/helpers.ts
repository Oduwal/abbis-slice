import { Store } from '../src/store/store.ts';
import type { Site } from '../src/domain/types.ts';

export const CENTRE: Site = { id: 'C', name: 'Centre', type: 'blood_centre', region: 'R', lat: -1.29, lon: 36.82 };
export const H1: Site = { id: 'H1', name: 'Hospital One', type: 'hospital', region: 'R', lat: -1.3, lon: 36.8 };
export const H2: Site = { id: 'H2', name: 'Hospital Two', type: 'hospital', region: 'R', lat: -0.3, lon: 36.08 };

/** A controllable clock so HLC ordering in tests does not depend on timing. */
export function clock(startIso = '2026-10-01T08:00:00Z') {
  let t = Date.parse(startIso);
  return { now: () => t, advance: (ms: number) => (t += ms), iso: () => new Date(t).toISOString() };
}

export function node(id: string, c = clock()): Store {
  const s = new Store(':memory:', id, c.now);
  for (const site of [CENTRE, H1, H2]) s.upsertSite(site);
  return s;
}

/** Collect, test and deliver one unit to a hospital. */
export function stockUnit(s: Store, din: string, at: string, to = 'H1', opts: { component?: string; bloodGroup?: string; expiresAt?: string } = {}) {
  const t = Date.parse(at);
  const iso = (ms: number) => new Date(t + ms).toISOString();
  s.append({
    din,
    type: 'COLLECTED',
    siteId: 'C',
    actor: 'lab',
    at: iso(0),
    payload: { component: opts.component ?? 'RBC', bloodGroup: opts.bloodGroup ?? 'O+', expiresAt: opts.expiresAt ?? iso(35 * 86_400_000) },
  });
  s.append({ din, type: 'TESTED', siteId: 'C', actor: 'lab', at: iso(1000), payload: { result: 'negative' } });
  s.append({ din, type: 'DISPATCHED', siteId: 'C', actor: 'inv', at: iso(2000), payload: { toSiteId: to } });
  s.append({ din, type: 'RECEIVED', siteId: to, actor: 'inv', at: iso(3000) });
}
