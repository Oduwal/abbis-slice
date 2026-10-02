/**
 * Demand forecasting for one series (site x blood group x component).
 *
 * Deliberately small and inspectable: blood demand per series is tens of units
 * a day at most, histories are short, and the people acting on the output need
 * to see *why* a number came out. A deep model would not beat a well-tuned
 * seasonal smoother on this data and could not be explained to a blood bank
 * manager. Every forecast is backtested against two baselines, and if the
 * model does not beat them we fall back to the simpler one and say so.
 */

export interface DayValue {
  day: string; // YYYY-MM-DD
  value: number;
}

export type ModelName = 'holt_winters' | 'moving_average' | 'insufficient_history';

export interface Backtest {
  holdoutDays: number;
  maeModel: number;
  maeMovingAverage: number;
  maeSeasonalNaive: number;
  /** 1 - MAE(chosen) / MAE(seasonal naive). >0 means the model adds value. */
  skill: number;
}

export interface Forecast {
  model: ModelName;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  history: DayValue[];
  points: { day: string; mean: number; low: number; high: number }[];
  horizonTotal: { mean: number; high: number };
  /** Std. dev. of one-day forecast error, for intervals over any window. */
  residualSd: number;
  backtest: Backtest | null;
  explanation: {
    meanDailyLast28: number;
    trendPct: number; // last 14 days vs previous 14 days
    weekdayEffect: Record<string, number>; // additive, units/day
    trendPerDay?: number; // fitted (damped) trend, units/day
    params?: { alpha: number; gamma: number; beta: number };
  };
}

export interface ForecastOptions {
  horizon: number;
  minHistoryDays: number;
  holdoutDays: number;
  intervalZ: number; // 1.2816 => 80% two-sided / P90 one-sided
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dow(day: string): number {
  return new Date(day + 'T00:00:00Z').getUTCDay();
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const mae = (a: number[], b: number[]) => mean(a.map((x, i) => Math.abs(x - b[i])));

/** Fill gaps with zeros so every calendar day is present up to (not including) `until`. */
export function densify(rows: DayValue[], until: string): DayValue[] {
  if (!rows.length) return [];
  const map = new Map(rows.map((r) => [r.day, r.value]));
  const out: DayValue[] = [];
  for (let d = rows[0].day; d < until; d = addDays(d, 1)) out.push({ day: d, value: map.get(d) ?? 0 });
  return out;
}

// ---------- seasonal exponential smoothing (level + damped trend + weekly additive season) ----------

interface ESState {
  level: number;
  trend: number;
  phi: number;
  season: number[]; // indexed by day of week
  oneStepErrors: number[];
}

const PHI = 0.9; // trend damping: a recent rise is assumed to flatten out, not continue forever

function fitES(series: DayValue[], alpha: number, gamma: number, beta: number): ESState {
  const warm = series.slice(0, 14);
  let level = mean(warm.map((d) => d.value));
  const season = new Array(7).fill(0);
  for (let k = 0; k < 7; k++) {
    const vals = warm.filter((d) => dow(d.day) === k).map((d) => d.value);
    season[k] = vals.length ? mean(vals) - level : 0;
  }
  let trend = 0;
  const errors: number[] = [];
  for (const d of series.slice(14)) {
    const k = dow(d.day);
    const predicted = Math.max(0, level + PHI * trend + season[k]);
    errors.push(d.value - predicted);
    const prevLevel = level;
    level = alpha * (d.value - season[k]) + (1 - alpha) * (level + PHI * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * PHI * trend;
    season[k] = gamma * (d.value - level) + (1 - gamma) * season[k];
  }
  return { level, trend, phi: PHI, season, oneStepErrors: errors };
}

function predictES(s: ESState, lastDay: string, h: number): number[] {
  const out: number[] = [];
  let damp = 0;
  for (let i = 1; i <= h; i++) {
    damp += Math.pow(s.phi, i);
    out.push(Math.max(0, s.level + damp * s.trend + s.season[dow(addDays(lastDay, i))]));
  }
  return out;
}

const ALPHAS = [0.05, 0.1, 0.2, 0.3, 0.5];
const GAMMAS = [0.05, 0.1, 0.2, 0.3];
const BETAS = [0, 0.05, 0.15];

function tuneES(series: DayValue[]): { alpha: number; gamma: number; beta: number; state: ESState } {
  let best = { alpha: 0.1, gamma: 0.1, beta: 0, state: fitES(series, 0.1, 0.1, 0), score: Infinity };
  for (const alpha of ALPHAS)
    for (const gamma of GAMMAS)
      for (const beta of BETAS) {
        const state = fitES(series, alpha, gamma, beta);
        const score = mean(state.oneStepErrors.map(Math.abs));
        if (score < best.score) best = { alpha, gamma, beta, state, score };
      }
  return best;
}

// ---------- baselines ----------

function movingAverage(series: DayValue[], window = 28): number {
  return mean(series.slice(-window).map((d) => d.value));
}

function seasonalNaive(series: DayValue[], h: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < h; i++) out.push(series[series.length - 7 + (i % 7)]?.value ?? 0);
  return out;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// ---------- public API ----------

export function forecast(rows: DayValue[], asOf: string, opts: ForecastOptions): Forecast {
  const history = densify(rows, asOf);
  const lastDay = addDays(asOf, -1);
  const values = history.map((d) => d.value);
  const last28 = values.slice(-28);
  const explanation: Forecast['explanation'] = {
    meanDailyLast28: round(mean(last28)),
    trendPct: trendPct(values),
    weekdayEffect: {},
  };

  if (history.length < opts.minHistoryDays) {
    const m = mean(values);
    const s = Math.max(sd(values), Math.sqrt(Math.max(m, 0.25))); // Poisson floor
    const points = futureDays(lastDay, opts.horizon).map((day) => ({ day, mean: round(m), low: 0, high: round(m + opts.intervalZ * s) }));
    return {
      model: 'insufficient_history',
      confidence: 'low',
      reason: `Only ${history.length} days of history (need ${opts.minHistoryDays}); using the plain average. Review manually.`,
      history,
      points,
      horizonTotal: totals(points, s, opts),
      residualSd: round(s),
      backtest: null,
      explanation,
    };
  }

  // Backtest on a holdout window the model has not seen.
  const train = history.slice(0, -opts.holdoutDays);
  const test = history.slice(-opts.holdoutDays).map((d) => d.value);
  const tuned = tuneES(train);
  const esPred = predictES(tuned.state, train[train.length - 1].day, opts.holdoutDays);
  const maPred = new Array(opts.holdoutDays).fill(movingAverage(train));
  const snPred = seasonalNaive(train, opts.holdoutDays);
  const maeES = mae(test, esPred);
  const maeMA = mae(test, maPred);
  const maeSN = mae(test, snPred);

  const useES = maeES <= maeMA;
  const maeChosen = useES ? maeES : maeMA;
  const skill = maeSN > 0 ? 1 - maeChosen / maeSN : maeChosen === 0 ? 0 : -1;
  const backtest: Backtest = {
    holdoutDays: opts.holdoutDays,
    maeModel: round(maeChosen),
    maeMovingAverage: round(maeMA),
    maeSeasonalNaive: round(maeSN),
    skill: round(skill),
  };

  let point: number[];
  let residualSd: number;
  let reason: string;
  if (useES) {
    const full = tuneES(history);
    point = predictES(full.state, lastDay, opts.horizon);
    residualSd = sd(full.state.oneStepErrors.slice(-56));
    full.state.season.forEach((v, k) => (explanation.weekdayEffect[DOW[k]] = round(v)));
    explanation.params = { alpha: full.alpha, gamma: full.gamma, beta: full.beta };
    explanation.trendPerDay = round(full.state.trend);
    reason = `Holt-Winters (level, damped trend, weekday) beat the 28-day average on the last ${opts.holdoutDays} days (MAE ${round(maeES)} vs ${round(maeMA)}).`;
  } else {
    const m = movingAverage(history);
    point = new Array(opts.horizon).fill(m);
    residualSd = sd(history.slice(-56).map((d) => d.value - m));
    reason = `Weekly pattern did not help on the last ${opts.holdoutDays} days (MAE ${round(maeES)} vs ${round(maeMA)}); fell back to the 28-day average.`;
  }
  residualSd = Math.max(residualSd, Math.sqrt(Math.max(mean(point), 0.25)) * 0.5);

  const confidence: Forecast['confidence'] = skill > 0.15 && history.length >= 56 ? 'high' : skill > 0 ? 'medium' : 'low';
  if (confidence === 'low') reason += ' Model does not beat "same day last week"; treat as indicative only.';

  const points = futureDays(lastDay, opts.horizon).map((day, i) => ({
    day,
    mean: round(point[i]),
    low: round(Math.max(0, point[i] - opts.intervalZ * residualSd)),
    high: round(point[i] + opts.intervalZ * residualSd),
  }));
  return {
    model: useES ? 'holt_winters' : 'moving_average',
    confidence,
    reason,
    history,
    points,
    horizonTotal: totals(points, residualSd, opts),
    residualSd: round(residualSd),
    backtest,
    explanation,
  };
}

function futureDays(lastDay: string, h: number): string[] {
  return Array.from({ length: h }, (_, i) => addDays(lastDay, i + 1));
}

function totals(points: { mean: number }[], dailySd: number, opts: ForecastOptions) {
  const m = points.reduce((a, p) => a + p.mean, 0);
  return { mean: round(m), high: round(m + opts.intervalZ * dailySd * Math.sqrt(points.length)) };
}

function trendPct(values: number[]): number {
  const recent = mean(values.slice(-14));
  const prior = mean(values.slice(-28, -14));
  return prior > 0 ? round(((recent - prior) / prior) * 100) : 0;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
