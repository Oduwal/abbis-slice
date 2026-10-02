import type { Config } from '../config.ts';
import type { UnitEvent, UnitState } from '../domain/types.ts';

/**
 * HL7 FHIR R4 facade over the internal model, so hospital systems and a
 * national platform (e.g. a DHIS2 / OpenHIE stack) can read blood products
 * without learning our schema. Internal storage stays event-sourced; FHIR is a
 * view. Code systems marked "example.org" are placeholders until ISBT 128 /
 * national terminology bindings are agreed in a pilot.
 */

const SYS = {
  din: 'http://example.org/fhir/sid/isbt128-din',
  component: 'http://example.org/fhir/CodeSystem/blood-component',
  abo: 'http://example.org/fhir/StructureDefinition/blood-group',
  site: 'http://example.org/fhir/sid/blood-service-site',
};

export function toBiologicallyDerivedProduct(u: UnitState, config: Config) {
  const comp = config.components[u.component];
  return {
    resourceType: 'BiologicallyDerivedProduct',
    id: u.din,
    meta: { lastUpdated: u.lastEventAt },
    identifier: [{ system: SYS.din, value: u.din }],
    productCategory: comp.fhirCategory,
    productCode: { coding: [{ system: SYS.component, code: u.component, display: comp.label }], text: comp.label },
    status: u.status === 'available' ? 'available' : 'unavailable',
    extension: [
      { url: SYS.abo, valueString: u.bloodGroup },
      { url: 'http://example.org/fhir/StructureDefinition/unit-status', valueCode: u.status },
      { url: 'http://example.org/fhir/StructureDefinition/current-location', valueIdentifier: { system: SYS.site, value: u.siteId } },
    ],
    collection: { collectedDateTime: u.collectedAt },
    storage: [{ description: comp.storage, duration: { start: u.collectedAt, end: u.expiresAt } }],
  };
}

/** Each lifecycle event as a FHIR Provenance resource: who did what, where, when. */
export function toProvenance(e: UnitEvent) {
  return {
    resourceType: 'Provenance',
    id: e.id,
    target: [{ reference: `BiologicallyDerivedProduct/${e.din}` }],
    occurredDateTime: e.at,
    recorded: e.at,
    activity: { coding: [{ system: 'http://example.org/fhir/CodeSystem/unit-event', code: e.type }] },
    agent: [{ who: { identifier: { value: e.actor } }, onBehalfOf: { identifier: { system: SYS.site, value: e.siteId } } }],
  };
}

export function bundle(resources: object[], type: 'searchset' | 'collection' = 'searchset') {
  return {
    resourceType: 'Bundle',
    type,
    total: resources.length,
    entry: resources.map((resource) => ({ resource })),
  };
}
