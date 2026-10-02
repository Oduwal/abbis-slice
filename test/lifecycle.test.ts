import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RejectedError } from '../src/store/store.ts';
import { node, stockUnit } from './helpers.ts';

test('a unit moves vein to vein and every step is in its history', () => {
  const s = node('n1');
  stockUnit(s, 'U1', '2026-10-01T08:00:00Z');
  s.append({ din: 'U1', type: 'ISSUED', siteId: 'H1', actor: 'clin', at: '2026-10-01T12:00:00Z', payload: { patientRef: 'P1' } });
  s.append({ din: 'U1', type: 'TRANSFUSED', siteId: 'H1', actor: 'clin', at: '2026-10-01T12:30:00Z' });
  const u = s.unit('U1')!;
  assert.equal(u.status, 'transfused');
  assert.equal(u.siteId, 'H1');
  assert.equal(u.patientRef, 'P1');
  assert.deepEqual(
    s.events('U1').map((e) => e.type),
    ['COLLECTED', 'TESTED', 'DISPATCHED', 'RECEIVED', 'ISSUED', 'TRANSFUSED'],
  );
});

test('untested units cannot be issued', () => {
  const s = node('n1');
  s.append({ din: 'U2', type: 'COLLECTED', siteId: 'C', actor: 'lab', at: '2026-10-01T08:00:00Z', payload: { component: 'RBC', bloodGroup: 'A+', expiresAt: '2026-11-05T08:00:00Z' } });
  assert.throws(
    () => s.append({ din: 'U2', type: 'ISSUED', siteId: 'C', actor: 'clin', at: '2026-10-01T09:00:00Z', payload: { patientRef: 'P' } }),
    RejectedError,
  );
});

test('a reactive TTI screen discards the unit permanently', () => {
  const s = node('n1');
  s.append({ din: 'U3', type: 'COLLECTED', siteId: 'C', actor: 'lab', at: '2026-10-01T08:00:00Z', payload: { component: 'RBC', bloodGroup: 'B+', expiresAt: '2026-11-05T08:00:00Z' } });
  s.append({ din: 'U3', type: 'TESTED', siteId: 'C', actor: 'lab', at: '2026-10-01T10:00:00Z', payload: { result: 'reactive' } });
  assert.equal(s.unit('U3')!.status, 'discarded');
  assert.throws(() => s.append({ din: 'U3', type: 'DISPATCHED', siteId: 'C', actor: 'inv', at: '2026-10-01T11:00:00Z', payload: { toSiteId: 'H1' } }));
});

test('expired units cannot be issued', () => {
  const s = node('n1');
  stockUnit(s, 'U4', '2026-10-01T08:00:00Z', 'H1', { component: 'PLT', expiresAt: '2026-10-03T08:00:00Z' });
  assert.throws(
    () => s.append({ din: 'U4', type: 'ISSUED', siteId: 'H1', actor: 'clin', at: '2026-10-03T09:00:00Z', payload: { patientRef: 'P' } }),
    /expired/,
  );
});

test('a unit can only be acted on where it physically is', () => {
  const s = node('n1');
  stockUnit(s, 'U5', '2026-10-01T08:00:00Z', 'H1');
  assert.throws(
    () => s.append({ din: 'U5', type: 'ISSUED', siteId: 'H2', actor: 'clin', at: '2026-10-01T12:00:00Z', payload: { patientRef: 'P' } }),
    /held at H1/,
  );
});

test('a reservation is honoured: another patient cannot take the unit', () => {
  const s = node('n1');
  stockUnit(s, 'U6', '2026-10-01T08:00:00Z');
  s.append({ din: 'U6', type: 'RESERVED', siteId: 'H1', actor: 'inv', at: '2026-10-01T10:00:00Z', payload: { patientRef: 'P1' } });
  assert.throws(
    () => s.append({ din: 'U6', type: 'ISSUED', siteId: 'H1', actor: 'clin', at: '2026-10-01T11:00:00Z', payload: { patientRef: 'P2' } }),
    /different patient/,
  );
  s.append({ din: 'U6', type: 'ISSUED', siteId: 'H1', actor: 'clin', at: '2026-10-01T11:00:00Z', payload: { patientRef: 'P1' } });
});

test('appending with the same event id twice is a no-op (safe client retries)', () => {
  const s = node('n1');
  stockUnit(s, 'U7', '2026-10-01T08:00:00Z');
  const e = { id: 'fixed-id', din: 'U7', type: 'ISSUED' as const, siteId: 'H1', actor: 'clin', at: '2026-10-01T12:00:00Z', payload: { patientRef: 'P' } };
  s.append(e);
  s.append(e);
  assert.equal(s.events('U7').filter((x) => x.type === 'ISSUED').length, 1);
});
