import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HLC, decode } from '../src/sync/hlc.ts';
import { syncWith, localPeer, type PeerTransport } from '../src/sync/sync.ts';
import { node, stockUnit, clock } from './helpers.ts';

test('HLC never goes backwards, even if the wall clock does', () => {
  let t = 1_000_000;
  const c = new HLC('a', () => t);
  const a = c.tick();
  t -= 5000; // clock jumps back (NTP correction, dead RTC battery...)
  const b = c.tick();
  assert.ok(b > a);
});

test('HLC moves past timestamps received from a peer with a fast clock', () => {
  const c = new HLC('slow', () => 1000);
  c.receive(new HLC('fast', () => 9_000_000).tick());
  assert.ok(decode(c.tick()).ms >= 9_000_000);
});

test('two nodes converge to the same state after syncing', async () => {
  const central = node('central');
  const hospital = node('hospital');
  stockUnit(central, 'U1', '2026-10-01T08:00:00Z', 'H1');
  await syncWith(hospital, 'central', localPeer(central));
  hospital.append({ din: 'U1', type: 'ISSUED', siteId: 'H1', actor: 'clin', at: '2026-10-01T12:00:00Z', payload: { patientRef: 'P1' } });
  await syncWith(hospital, 'central', localPeer(central));
  assert.equal(central.unit('U1')!.status, 'issued');
  assert.deepEqual(central.unit('U1'), hospital.unit('U1'));
  assert.equal(central.events('U1').length, hospital.events('U1').length);
});

test('the same unit issued at two offline sites becomes a conflict, not a silent overwrite', async () => {
  const c = clock();
  const central = node('central', c);
  const a = node('site-a', c);
  const b = node('site-b', c);
  stockUnit(central, 'U9', '2026-10-01T08:00:00Z', 'H1');
  await syncWith(a, 'central', localPeer(central));
  await syncWith(b, 'central', localPeer(central));

  // Both go offline. Two clinicians at H1 each issue the last O+ unit from their own terminal.
  c.advance(3600_000);
  a.append({ din: 'U9', type: 'ISSUED', siteId: 'H1', actor: 'clin-a', at: c.iso(), payload: { patientRef: 'PA' } });
  c.advance(60_000);
  b.append({ din: 'U9', type: 'ISSUED', siteId: 'H1', actor: 'clin-b', at: c.iso(), payload: { patientRef: 'PB' } });

  // Connectivity returns.
  await syncWith(a, 'central', localPeer(central));
  const r = await syncWith(b, 'central', localPeer(central));
  await syncWith(a, 'central', localPeer(central));

  assert.ok(r.conflicts >= 1);
  for (const s of [central, a, b]) {
    assert.equal(s.unit('U9')!.patientRef, 'PA', `${s.nodeId}: earliest event in causal order stands`);
    const open = s.conflicts();
    assert.equal(open.length, 1, `${s.nodeId}: one open conflict`);
    assert.match(open[0].reason, /clin-b/);
  }
  // Nothing is lost: both events are in the audit trail everywhere.
  assert.equal(central.events('U9').filter((e) => e.type === 'ISSUED').length, 2);
});

test('an interrupted sync resumes from where it stopped and never duplicates', async () => {
  const central = node('central');
  for (let i = 0; i < 30; i++) stockUnit(central, `U${i}`, '2026-10-01T08:00:00Z');
  const hospital = node('hospital');

  // A link that drops after the second page.
  let calls = 0;
  const flaky: PeerTransport = {
    pull: async (since, limit) => {
      if (++calls === 3) throw new Error('connection reset');
      return central.exportSince(since, limit);
    },
    push: async (events) => central.importEvents(events),
  };
  const first = await syncWith(hospital, 'central', flaky, 25);
  assert.equal(first.error, 'connection reset');
  assert.equal(hospital.stats().events, 50);

  const second = await syncWith(hospital, 'central', localPeer(central), 25);
  assert.equal(second.error, undefined);
  assert.equal(hospital.stats().events, central.stats().events);
  assert.equal(hospital.stats().units, 30);
});
