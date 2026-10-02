import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../store/store.ts';
import { loadConfig, ROOT } from '../config.ts';
import { generate, generateDonors } from './generate.ts';
import { Donors } from '../donor/donors.ts';

const dbPath = process.env.DB_PATH ?? join(ROOT, 'data/central.db');
const days = Number(process.env.DAYS ?? 120);
const seed = Number(process.env.SEED ?? 42);

for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
const store = new Store(dbPath, process.env.NODE_ID ?? 'central');
const t0 = Date.now();
const endDay = new Date().toISOString().slice(0, 10);
const r = generate(store, loadConfig(), { days, endDay, seed });
const d = generateDonors(store, new Donors(store), loadConfig(), { count: 400, seed });
console.log(`Synthetic history: ${days} days to ${endDay}, seed ${seed}`);
console.log(`  donations ${r.units}, events ${r.events}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  donors ${d.donors}, appeals ${d.appeals}`);
console.log('  ', store.stats());
console.log(`Wrote ${dbPath}`);
