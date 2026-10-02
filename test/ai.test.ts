import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast, addDays } from '../src/ai/forecast.ts';
import { advise, unitsAtRisk } from '../src/ai/advisor.ts';
import { loadConfig } from '../src/config.ts';
import { rng } from '../src/synthetic/generate.ts';
import { node, stockUnit } from './helpers.ts';
import type { UnitState } from '../src/domain/types.ts';

const OPTS = { horizon: 7, minHistoryDays: 28, holdoutDays: 14, intervalZ: 1.2816 };

function series(days: number, f: (dow: number, i: number) => number, end = '2026-10-01') {
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(end, i - days);
    return { day, value: f(new Date(day + 'T00:00:00Z').getUTCDay(), i) };
  });
}

test('falls back and says so when history is too short', () => {
  const f = forecast(series(10, () => 5), '2026-10-01', OPTS);
  assert.equal(f.model, 'insufficient_history');
  assert.equal(f.confidence, 'low');
  assert.match(f.reason, /Only 10 days/);
});

test('learns a weekday pattern and beats the naive baselines on it', () => {
  const r = rng(7);
  const weekday = [2, 12, 12, 11, 11, 10, 5];
  const f = forecast(series(120, (d) => weekday[d] + Math.round((r() - 0.5) * 2)), '2026-10-01', OPTS);
  assert.equal(f.model, 'holt_winters');
  assert.ok(f.backtest!.skill > 0, `skill ${f.backtest!.skill}`);
  const sunday = f.points.find((p) => new Date(p.day + 'T00:00:00Z').getUTCDay() === 0)!;
  const monday = f.points.find((p) => new Date(p.day + 'T00:00:00Z').getUTCDay() === 1)!;
  assert.ok(monday.mean > sunday.mean + 5);
});

test('prediction interval contains the mean and is never negative', () => {
  const r = rng(3);
  const f = forecast(series(90, () => Math.floor(r() * 4)), '2026-10-01', OPTS);
  for (const p of f.points) {
    assert.ok(p.low >= 0);
    assert.ok(p.low <= p.mean && p.mean <= p.high);
  }
});

test('FEFO expiry risk: units beyond what demand can use before expiry are flagged', () => {
  const asOf = '2026-10-01T00:00:00Z';
  const mk = (din: string, days: number) => ({ din, expiresAt: new Date(Date.parse(asOf) + days * 86_400_000).toISOString() }) as UnitState;
  // 1 unit/day demand, 4 units expiring in 2 days: only ~2 will be used.
  const stock = [mk('a', 2), mk('b', 2), mk('c', 2), mk('d', 2), mk('e', 30)];
  assert.deepEqual(unitsAtRisk(stock, 1, asOf), ['c', 'd']);
});

test('advisor proposes moving short-dated surplus to a hospital that needs it, and explains why', () => {
  const s = node('n');
  const now = new Date();
  const day = (k: number) => addDays(now.toISOString().slice(0, 10), k);
  // H2 uses ~6 A+ red cells a day and has none; H1 uses almost none and holds 8 that expire in 3 days.
  for (let k = -60; k < 0; k++) {
    s.recordDemand('H2', 'A+', 'RBC', day(k), 6, 6);
    s.recordDemand('H1', 'A+', 'RBC', day(k), k % 20 === 0 ? 1 : 0, 0);
  }
  const collected = new Date(now.getTime() - 32 * 86_400_000).toISOString();
  for (let i = 0; i < 8; i++)
    stockUnit(s, `A${i}`, collected, 'H1', { bloodGroup: 'A+', expiresAt: new Date(now.getTime() + 3 * 86_400_000).toISOString() });
  const r = advise(s, loadConfig(), now.toISOString());
  const move = r.suggestions.find((x) => x.fromSiteId === 'H1' && x.toSiteId === 'H2' && x.bloodGroup === 'A+');
  assert.ok(move, 'expected a transfer suggestion H1 -> H2');
  assert.ok(move!.dins.length >= 5);
  assert.ok(move!.impact.expiriesAvoided >= 5);
  assert.ok(move!.explanation.some((e) => /expire/.test(e)));
});
