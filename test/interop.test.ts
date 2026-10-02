import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, canRecord, can } from '../src/auth.ts';
import { toBiologicallyDerivedProduct, toProvenance } from '../src/fhir/mapper.ts';
import { loadConfig } from '../src/config.ts';
import { node, stockUnit } from './helpers.ts';

test('tokens are tamper-evident', () => {
  const t = sign({ sub: 'u1', name: 'U', role: 'clinician', siteId: 'H1' });
  assert.equal(verify(t)!.role, 'clinician');
  const [body, mac] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), role: 'admin' })).toString('base64url');
  assert.equal(verify(`${forged}.${mac}`), null);
});

test('roles and sites limit what a user can record', () => {
  const clin = verify(sign({ sub: 'c', name: 'C', role: 'clinician', siteId: 'H1' }))!;
  assert.equal(canRecord(clin, 'ISSUED', 'H1'), null);
  assert.match(canRecord(clin, 'ISSUED', 'H2')!, /assigned to H1/);
  assert.match(canRecord(clin, 'TESTED', 'H1')!, /may not record TESTED/);
  const inv = verify(sign({ sub: 'i', name: 'I', role: 'inventory_officer', siteId: 'H1' }))!;
  assert.equal(can(inv, 'approve_suggestion', 'H1'), null);
  assert.ok(can(inv, 'approve_suggestion', 'H2'));
  assert.ok(can(clin, 'sync'));
});

test('a unit maps to a FHIR R4 BiologicallyDerivedProduct with provenance', () => {
  const s = node('n');
  stockUnit(s, 'X1-RBC', '2026-10-01T08:00:00Z');
  const r = toBiologicallyDerivedProduct(s.unit('X1-RBC')!, loadConfig());
  assert.equal(r.resourceType, 'BiologicallyDerivedProduct');
  assert.equal(r.status, 'available');
  assert.equal(r.productCategory, 'cells');
  assert.equal(r.identifier[0].value, 'X1-RBC');
  const prov = s.events('X1-RBC').map(toProvenance);
  assert.equal(prov.length, 4);
  assert.equal(prov[0].target[0].reference, 'BiologicallyDerivedProduct/X1-RBC');
});
