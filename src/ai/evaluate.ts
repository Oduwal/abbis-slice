import { join } from 'node:path';
import { Store } from '../store/store.ts';
import { loadConfig, ROOT } from '../config.ts';
import { forecast, addDays, densify } from './forecast.ts';
import { BLOOD_GROUPS, COMPONENTS } from '../domain/types.ts';

/**
 * Rolling-origin evaluation of the forecaster on the synthetic history.
 *
 * For every series we pretend "today" is each of the last N weeks in turn,
 * forecast the next 7 days using only data before that day, and compare with
 * what actually happened. Results are grouped by volume, because a rare blood
 * group at a small hospital (a handful of units a month) behaves completely
 * differently from O+ red cells at a referral hospital.
 *
 *   npm run eval
 */

const store = new Store(process.env.DB_PATH ?? join(ROOT, 'data/central.db'), 'eval');
const config = loadConfig();
const H = 7;
const ORIGINS = Number(process.env.ORIGINS ?? 6);
const today = new Date().toISOString().slice(0, 10);

type Row = { tier: string; model: string; mae: number; maeNaive: number; maeMA: number; covered: number; n: number };
const rows: Row[] = [];

for (const site of store.sites().filter((s) => s.type === 'hospital')) {
  for (const component of COMPONENTS) {
    for (const bloodGroup of BLOOD_GROUPS) {
      const all = densify(
        store.demandSeries(site.id, bloodGroup, component).map((r) => ({ day: r.day, value: r.requested })),
        today,
      );
      if (all.length < 60) continue;
      const meanDaily = all.slice(-56).reduce((a, d) => a + d.value, 0) / 56;
      const tier = meanDaily >= 3 ? 'high (>=3/day)' : meanDaily >= 0.5 ? 'medium (0.5-3/day)' : 'sparse (<0.5/day)';
      for (let k = ORIGINS; k >= 1; k--) {
        const origin = addDays(today, -k * H);
        const train = all.filter((d) => d.day < origin);
        const actual = all.filter((d) => d.day >= origin && d.day < addDays(origin, H)).map((d) => d.value);
        if (actual.length < H) continue;
        const f = forecast(train, origin, { horizon: H, ...config.forecast });
        const pred = f.points.map((p) => p.mean);
        const naive = train.slice(-7).map((d) => d.value);
        const ma = train.slice(-28).reduce((a, d) => a + d.value, 0) / Math.min(28, train.length);
        const err = (p: number[]) => p.reduce((a, x, i) => a + Math.abs(x - actual[i]), 0) / H;
        const covered = f.points.filter((p, i) => actual[i] <= p.high).length / H;
        rows.push({ tier, model: f.model, mae: err(pred), maeNaive: err(naive), maeMA: err(new Array(H).fill(ma)), covered, n: 1 });
      }
    }
  }
}

const groups = new Map<string, Row[]>();
for (const r of rows) groups.set(r.tier, [...(groups.get(r.tier) ?? []), r]);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

console.log(`Rolling-origin backtest: ${ORIGINS} weekly origins x ${H}-day horizon, ${rows.length} forecasts\n`);
console.log('| Volume tier | Forecasts | MAE model | MAE same-day-last-week | MAE 28-day avg | Skill vs naive | P90 coverage |');
console.log('|---|---|---|---|---|---|---|');
for (const tier of ['high (>=3/day)', 'medium (0.5-3/day)', 'sparse (<0.5/day)']) {
  const g = groups.get(tier);
  if (!g) continue;
  const m = avg(g.map((r) => r.mae));
  const nv = avg(g.map((r) => r.maeNaive));
  const ma = avg(g.map((r) => r.maeMA));
  console.log(
    `| ${tier} | ${g.length} | ${m.toFixed(2)} | ${nv.toFixed(2)} | ${ma.toFixed(2)} | ${((1 - m / nv) * 100).toFixed(0)}% | ${(avg(g.map((r) => r.covered)) * 100).toFixed(0)}% |`,
  );
}
const models: Record<string, number> = {};
for (const r of rows) models[r.model] = (models[r.model] ?? 0) + 1;
console.log('\nModel chosen by the per-series backtest:', models);
console.log('P90 coverage = share of days where actual demand was at or below the upper band (target ~90%).');
