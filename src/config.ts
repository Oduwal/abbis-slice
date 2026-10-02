import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BloodGroup, Component } from './domain/types.ts';

/**
 * Everything that differs between blood services lives in configuration, not
 * code: component shelf lives (CPDA-1 vs SAGM red cells), the TTI panel, the
 * local blood group mix used by the simulator, stock policy, language.
 * A deployment overrides config/default.json with config/<DEPLOYMENT>.json.
 */
export interface Config {
  deployment: string;
  locale: string;
  timezone: string;
  components: Record<Component, { label: string; shelfLifeDays: number; storage: string; fhirCategory: string }>;
  bloodGroupShare: Record<BloodGroup, number>;
  ttiPanel: string[];
  inventoryPolicy: {
    safetyStockDays: number;
    transportLeadDays: number;
    forecastHorizonDays: number;
    minShelfLifeOnArrivalDays: number;
    expiryWatchDays: number;
  };
  donor: { minDaysBetweenDonations: number; appealReachKm: number };
  forecast: { minHistoryDays: number; holdoutDays: number; intervalZ: number };
}

export const ROOT = new URL('..', import.meta.url).pathname;

function deepMerge<T>(base: T, over: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over ?? {})) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' ? deepMerge(b, v as never) : v;
  }
  return out as T;
}

export function loadConfig(deployment = process.env.DEPLOYMENT): Config {
  const base = JSON.parse(readFileSync(join(ROOT, 'config/default.json'), 'utf8')) as Config;
  if (!deployment) return base;
  const path = join(ROOT, `config/${deployment}.json`);
  if (!existsSync(path)) throw new Error(`No config for deployment "${deployment}" at ${path}`);
  return deepMerge(base, JSON.parse(readFileSync(path, 'utf8')));
}

export function loadLocales(): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(ROOT, 'config/locales.json'), 'utf8'));
}
