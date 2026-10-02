import { createHash } from 'node:crypto';
import { forecast, type Forecast } from './forecast.ts';
import { BLOOD_GROUPS, COMPONENTS } from '../domain/types.ts';
import type { BloodGroup, Component, Site, UnitState } from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import type { Config } from '../config.ts';

/**
 * Turns forecasts + live stock into (1) a risk assessment per series and
 * (2) concrete transfer suggestions. Suggestions are proposals only: nothing
 * moves until an inventory officer approves, and every suggestion carries the
 * numbers behind it so the officer can disagree with it.
 */

export interface Assessment {
  siteId: string;
  component: Component;
  bloodGroup: BloodGroup;
  available: number;
  incoming: number;
  meanDaily: number;
  need: number; // reorder point: P90 demand over lead time + safety days
  daysOfCover: number | null;
  deficit: number;
  atRisk: string[]; // DINs likely to expire before use at this site
  status: 'ok' | 'low' | 'critical' | 'expiry_risk';
  forecast: Pick<Forecast, 'model' | 'confidence' | 'reason' | 'horizonTotal' | 'backtest'>;
}

export interface Suggestion {
  id: string;
  kind: 'cover_shortage' | 'avoid_expiry';
  fromSiteId: string;
  toSiteId: string;
  component: Component;
  bloodGroup: BloodGroup;
  dins: string[];
  distanceKm: number;
  impact: { shortageCovered: number; expiriesAvoided: number };
  confidence: 'high' | 'medium' | 'low';
  explanation: string[];
}

export interface Alert {
  siteId: string;
  component: Component;
  bloodGroup: BloodGroup;
  severity: 'critical' | 'warning';
  shortfall: number;
  message: string;
}

export interface AdvisorResult {
  asOf: string;
  assessments: Assessment[];
  suggestions: Suggestion[];
  alerts: Alert[];
}

const DAY_MS = 86_400_000;

export function haversineKm(a: Site, b: Site): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function daysUntil(iso: string, asOf: string): number {
  return (Date.parse(iso) - Date.parse(asOf)) / DAY_MS;
}

/** Transport time between two sites: a courier across town is hours, not the policy's worst case. */
export function leadDays(km: number, maxLeadDays: number): number {
  return Math.min(maxLeadDays, Math.max(0.25, km / 300));
}

/** FEFO simulation: which units will still be on the shelf when they expire? */
export function unitsAtRisk(stock: UnitState[], meanDaily: number, asOf: string, watchDays = 14): string[] {
  const out: string[] = [];
  stock.forEach((u, i) => {
    if (daysUntil(u.expiresAt, asOf) > watchDays) return; // long-dated stock is a planning issue, not an expiry risk
    const expectedUsedBeforeExpiry = meanDaily * Math.max(0, daysUntil(u.expiresAt, asOf));
    if (i + 1 > expectedUsedBeforeExpiry + 1e-9) out.push(u.din);
  });
  return out;
}

export function advise(store: Store, config: Config, asOfIso: string = new Date().toISOString()): AdvisorResult {
  const asOfDay = asOfIso.slice(0, 10);
  const policy = config.inventoryPolicy;
  const sites = store.sites();
  const byId = new Map(sites.map((s) => [s.id, s]));
  const hospitals = sites.filter((s) => s.type === 'hospital');
  const centres = sites.filter((s) => s.type === 'blood_centre');

  const assessments: Assessment[] = [];
  const stockOf = new Map<string, UnitState[]>();
  const key = (s: string, c: string, g: string) => `${s}|${c}|${g}`;

  for (const site of sites) {
    for (const component of COMPONENTS) {
      for (const bloodGroup of BLOOD_GROUPS) {
        const stock = store.available(site.id, component, bloodGroup, asOfIso);
        stockOf.set(key(site.id, component, bloodGroup), stock);
        if (site.type !== 'hospital') continue;
        const rows = store.demandSeries(site.id, bloodGroup, component).map((r) => ({ day: r.day, value: r.requested }));
        if (!rows.length && !stock.length) continue;
        const f = forecast(rows, asOfDay, {
          horizon: policy.forecastHorizonDays,
          minHistoryDays: config.forecast.minHistoryDays,
          holdoutDays: config.forecast.holdoutDays,
          intervalZ: config.forecast.intervalZ,
        });
        const incoming = store.units({ status: 'in_transit', component, bloodGroup, limit: 10_000 }).filter(
          (u) => u.destinationSiteId === site.id,
        ).length;
        const meanDaily = f.horizonTotal.mean / policy.forecastHorizonDays;
        // Reorder-point logic: hold enough to survive P90 demand until a delivery
        // can arrive, plus the safety-stock days set by policy.
        const window = policy.transportLeadDays + policy.safetyStockDays;
        const sumMean = (n: number) => f.points.slice(0, n).reduce((acc, p) => acc + p.mean, 0);
        const need = Math.ceil(sumMean(window) + config.forecast.intervalZ * f.residualSd * Math.sqrt(window));
        const leadNeed = sumMean(policy.transportLeadDays);
        const deficit = Math.max(0, need - stock.length - incoming);
        const atRisk = unitsAtRisk(stock, meanDaily, asOfIso, policy.expiryWatchDays);
        const daysOfCover = meanDaily > 0 ? Math.round(((stock.length + incoming) / meanDaily) * 10) / 10 : null;
        let status: Assessment['status'] = 'ok';
        if (deficit > 0) status = stock.length + incoming < leadNeed ? 'critical' : 'low';
        else if (atRisk.length) status = 'expiry_risk';
        assessments.push({
          siteId: site.id,
          component,
          bloodGroup,
          available: stock.length,
          incoming,
          meanDaily: Math.round(meanDaily * 100) / 100,
          need,
          daysOfCover,
          deficit,
          atRisk,
          status,
          forecast: { model: f.model, confidence: f.confidence, reason: f.reason, horizonTotal: f.horizonTotal, backtest: f.backtest },
        });
      }
    }
  }

  const assessmentOf = new Map(assessments.map((a) => [key(a.siteId, a.component, a.bloodGroup), a]));
  const committed = new Set<string>();
  const suggestions: Suggestion[] = [];
  const alerts: Alert[] = [];

  // Units a site can release without hurting itself: its at-risk units, plus
  // anything above its own need (latest-expiring last, so it keeps fresh stock).
  const releasable = (siteId: string, toSite: Site, c: Component, g: BloodGroup): { unit: UnitState; atRisk: boolean }[] => {
    const site = byId.get(siteId)!;
    const minShelf = leadDays(haversineKm(site, toSite), policy.transportLeadDays) + policy.minShelfLifeOnArrivalDays;
    const stock = (stockOf.get(key(siteId, c, g)) ?? []).filter(
      (u) => !committed.has(u.din) && daysUntil(u.expiresAt, asOfIso) >= minShelf,
    );
    if (site.type === 'blood_centre') return stock.map((unit) => ({ unit, atRisk: false }));
    const a = assessmentOf.get(key(siteId, c, g));
    if (!a || a.deficit > 0) return [];
    const risk = new Set(a.atRisk);
    const atRisk = stock.filter((u) => risk.has(u.din));
    const spareCount = Math.max(0, a.available - a.need - atRisk.length);
    const spare = stock.filter((u) => !risk.has(u.din)).slice(0, spareCount);
    return [...atRisk.map((unit) => ({ unit, atRisk: true })), ...spare.map((unit) => ({ unit, atRisk: false }))];
  };

  const label = (c: Component) => config.components[c].label.toLowerCase();

  // 1. Cover shortages, most urgent first.
  const deficits = assessments.filter((a) => a.deficit > 0).sort((a, b) => (a.daysOfCover ?? 99) - (b.daysOfCover ?? 99));
  for (const d of deficits) {
    const to = byId.get(d.siteId)!;
    let remaining = d.deficit;
    // Prefer units that would otherwise expire elsewhere, then the blood centre, then other hospitals' spare stock; nearest first.
    const donors = [...hospitals, ...centres]
      .filter((s) => s.id !== to.id)
      .map((s) => ({ site: s, km: haversineKm(s, to), units: releasable(s.id, to, d.component, d.bloodGroup) }))
      .filter((x) => x.units.length);
    const ranked = donors.flatMap((x) =>
      x.units.map((u) => ({ ...u, site: x.site, km: x.km, rank: u.atRisk ? 0 : x.site.type === 'blood_centre' ? 1 : 2 })),
    );
    ranked.sort((a, b) => a.rank - b.rank || a.km - b.km || a.unit.expiresAt.localeCompare(b.unit.expiresAt));
    const bySource = new Map<string, typeof ranked>();
    for (const r of ranked) {
      if (remaining <= 0) break;
      committed.add(r.unit.din);
      remaining--;
      bySource.set(r.site.id, [...(bySource.get(r.site.id) ?? []), r]);
    }
    for (const [fromId, picks] of bySource) {
      const from = byId.get(fromId)!;
      const avoided = picks.filter((p) => p.atRisk).length;
      const explanation = [
        `${to.name} should hold at least ${d.need} ${d.bloodGroup} ${label(d.component)} to cover P90 demand until a delivery ` +
          `arrives plus ${policy.safetyStockDays} days safety stock (forecast ${d.meanDaily}/day), but holds ${d.available}` +
          (d.incoming ? ` with ${d.incoming} in transit.` : '.'),
        `Forecast: ${d.forecast.reason}`,
      ];
      if (avoided)
        explanation.push(
          `${avoided === picks.length ? (avoided === 1 ? 'This unit is' : 'All of these units are') : `${avoided} of these units are`} ` +
            `likely to expire unused at ${from.name}, so moving ${avoided === 1 ? 'it' : 'them'} also avoids waste.`,
        );
      if (from.type === 'blood_centre') explanation.push(`${from.name} is the supplying blood centre (${picks[0].km} km).`);
      suggestions.push(
        mkSuggestion('cover_shortage', from, to, d, picks.map((p) => p.unit.din), picks[0].km, picks.length, avoided, d.forecast.confidence, explanation),
      );
    }
    if (remaining > 0) {
      alerts.push({
        siteId: d.siteId,
        component: d.component,
        bloodGroup: d.bloodGroup,
        severity: d.status === 'critical' ? 'critical' : 'warning',
        shortfall: remaining,
        message:
          `${to.name}: ${remaining} ${d.bloodGroup} ${label(d.component)} short after all possible transfers. ` +
          `Consider targeted donor recall for ${d.bloodGroup} or compatible substitution under clinical guidance.`,
      });
    }
  }

  // 2. Rehome units that will expire where they are, if another hospital will use them in time.
  for (const a of assessments.filter((x) => x.atRisk.length)) {
    const from = byId.get(a.siteId)!;
    const units = (stockOf.get(key(a.siteId, a.component, a.bloodGroup)) ?? []).filter(
      (u) => a.atRisk.includes(u.din) && !committed.has(u.din),
    );
    if (!units.length) continue;
    const targets = hospitals
      .filter((h) => h.id !== from.id)
      .map((h) => ({ h, x: assessmentOf.get(key(h.id, a.component, a.bloodGroup)) }))
      .filter((t) => t.x && t.x.meanDaily > 0)
      .sort((p, q) => q.x!.meanDaily - p.x!.meanDaily);
    for (const t of targets) {
      const x = t.x!;
      const picks: UnitState[] = [];
      const lead = leadDays(haversineKm(from, t.h), policy.transportLeadDays);
      for (const u of units) {
        if (committed.has(u.din)) continue;
        if (daysUntil(u.expiresAt, asOfIso) < lead + policy.minShelfLifeOnArrivalDays) continue;
        // Would the target use it before expiry, given what it already holds?
        const usableDays = daysUntil(u.expiresAt, asOfIso) - lead;
        const ahead = x.available + x.incoming + picks.length;
        if (x.meanDaily * usableDays >= ahead + 1) picks.push(u);
      }
      if (!picks.length) continue;
      picks.forEach((u) => committed.add(u.din));
      const km = haversineKm(from, t.h);
      suggestions.push(
        mkSuggestion('avoid_expiry', from, t.h, a, picks.map((u) => u.din), km, 0, picks.length, x.forecast.confidence, [
          `${picks.length} ${a.bloodGroup} ${label(a.component)} at ${from.name} expire before expected use there ` +
            `(forecast ${a.meanDaily}/day against ${a.available} in stock).`,
          `${t.h.name} uses about ${x.meanDaily}/day and holds ${x.available}, so these units should be transfused before they expire.`,
          `Forecast at ${t.h.name}: ${x.forecast.reason}`,
        ]),
      );
    }
  }

  return { asOf: asOfIso, assessments, suggestions, alerts };
}

function mkSuggestion(
  kind: Suggestion['kind'],
  from: Site,
  to: Site,
  s: { component: Component; bloodGroup: BloodGroup },
  dins: string[],
  km: number,
  shortageCovered: number,
  expiriesAvoided: number,
  confidence: Suggestion['confidence'],
  explanation: string[],
): Suggestion {
  const id = createHash('sha256').update([kind, from.id, to.id, ...dins.sort()].join('|')).digest('hex').slice(0, 16);
  return {
    id,
    kind,
    fromSiteId: from.id,
    toSiteId: to.id,
    component: s.component,
    bloodGroup: s.bloodGroup,
    dins,
    distanceKm: km,
    impact: { shortageCovered, expiriesAvoided },
    confidence,
    explanation,
  };
}
