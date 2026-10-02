import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Donors, compatibleDonors, matchLevel } from '../src/donor/donors.ts';
import { node, H1 } from './helpers.ts';

test('red cell compatibility follows ABO and RhD rules', () => {
  assert.deepEqual(compatibleDonors('O-'), ['O-']);
  assert.deepEqual(new Set(compatibleDonors('A+')), new Set(['A-', 'A+', 'O-', 'O+']));
  assert.equal(compatibleDonors('AB+').length, 8); // universal recipient
  assert.ok(!compatibleDonors('B-').includes('B+')); // RhD negative recipients need RhD negative blood
  assert.ok(!compatibleDonors('A+').includes('B+'));
});

test('a donor sees whether they match an appeal exactly, compatibly, or not at all', () => {
  assert.equal(matchLevel('O+', ['O+']), 'exact');
  assert.equal(matchLevel('O-', ['B+']), 'compatible');
  assert.equal(matchLevel('A+', ['O+']), 'none');
  assert.equal(matchLevel('unknown', ['O+']), 'unknown');
});

test('donors must wait the configured interval between donations', () => {
  const d = new Donors(node('n'), 84);
  const now = new Date('2026-10-01T00:00:00Z');
  const recent = d.register({ name: 'A', bloodGroup: 'O+', lastDonationAt: '2026-09-01T00:00:00Z' });
  const old = d.register({ name: 'B', bloodGroup: 'O+', lastDonationAt: '2026-05-01T00:00:00Z' });
  assert.equal(d.eligibility(recent, now).eligible, false);
  assert.equal(d.eligibility(recent, now).nextEligibleAt!.slice(0, 10), '2026-11-24');
  assert.equal(d.eligibility(old, now).eligible, true);
});

test('pledges: only at collecting sites, one at a time, only when eligible', () => {
  const s = node('n');
  const d = new Donors(s, 84);
  const donor = d.register({ name: 'A', bloodGroup: 'O-', lat: -1.29, lon: 36.82 });
  const appeal = d.createAppeal({ siteId: 'H1', bloodGroups: ['O-'], component: 'RBC', unitsNeeded: 3, urgency: 'urgent', neededBy: '2026-10-05T00:00:00Z', note: '', createdBy: 'inv-H1', source: 'staff' });
  assert.throws(() => d.pledge({ donorId: donor.id, appealId: appeal.id, siteId: 'H1', slot: '2026-10-03T09:00:00Z' }), /does not collect/);
  d.setCollects('H1', true);
  d.pledge({ donorId: donor.id, appealId: appeal.id, siteId: 'H1', slot: '2026-10-03T09:00:00Z' });
  assert.throws(() => d.pledge({ donorId: donor.id, appealId: appeal.id, siteId: 'C', slot: '2026-10-03T10:00:00Z' }), /already have an upcoming/);
  assert.equal(d.appeals('open')[0].pledged, 1);

  const recent = d.register({ name: 'B', bloodGroup: 'O-', lastDonationAt: '2026-09-20T00:00:00Z' });
  assert.throws(() => d.pledge({ donorId: recent.id, appealId: appeal.id, siteId: 'C', slot: '2026-10-03T09:00:00Z' }), /not yet eligible/);
  d.closeAppeal(appeal.id);
  const other = d.register({ name: 'C', bloodGroup: 'O-' });
  assert.throws(() => d.pledge({ donorId: other.id, appealId: appeal.id, siteId: 'C', slot: '2026-10-03T09:00:00Z' }), /closed/);
});

test('appeal reach counts eligible matching donors near the requesting site', () => {
  const s = node('n');
  const d = new Donors(s, 84);
  d.register({ name: 'near-exact', bloodGroup: 'O-', lat: H1.lat + 0.05, lon: H1.lon });
  d.register({ name: 'near-wrong', bloodGroup: 'A+', lat: H1.lat, lon: H1.lon });
  d.register({ name: 'far', bloodGroup: 'O-', lat: 4.0, lon: 40.0 });
  d.register({ name: 'ineligible', bloodGroup: 'O-', lat: H1.lat, lon: H1.lon, lastDonationAt: new Date().toISOString() });
  assert.deepEqual(d.reach({ siteId: 'H1', bloodGroups: ['O-'] }, 50), { exact: 1, compatible: 0 });
});

test('donor location is stored coarsely, and a lab-confirmed group cannot be overwritten', () => {
  const d = new Donors(node('n'), 84);
  const x = d.register({ name: 'A', bloodGroup: 'A+', lat: -1.286389123, lon: 36.817223456, groupVerified: true });
  assert.equal(x.lat, -1.29);
  assert.equal(x.lon, 36.82);
  assert.equal(d.update(x.id, { bloodGroup: 'B+' }).bloodGroup, 'A+');
});
