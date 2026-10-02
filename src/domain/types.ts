export type Component = 'RBC' | 'PLT' | 'FFP';
export const COMPONENTS: Component[] = ['RBC', 'PLT', 'FFP'];

export type BloodGroup = 'O+' | 'O-' | 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-';
export const BLOOD_GROUPS: BloodGroup[] = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];

export type UnitStatus =
  | 'quarantine'
  | 'available'
  | 'reserved'
  | 'in_transit'
  | 'issued'
  | 'transfused'
  | 'discarded';

export type SiteType = 'blood_centre' | 'hospital';

export interface Site {
  id: string;
  name: string;
  type: SiteType;
  region: string;
  lat: number;
  lon: number;
}

export type Role = 'lab_tech' | 'inventory_officer' | 'clinician' | 'admin' | 'sync_peer' | 'donor';

export type EventType =
  | 'COLLECTED'
  | 'TESTED'
  | 'RESERVED'
  | 'DISPATCHED'
  | 'RECEIVED'
  | 'ISSUED'
  | 'TRANSFUSED'
  | 'RETURNED'
  | 'DISCARDED';

/**
 * One fact about one unit. Events are immutable, globally unique (id) and
 * ordered by a hybrid logical clock (hlc) so that nodes which were offline
 * can merge their logs deterministically.
 */
export interface UnitEvent {
  id: string;
  din: string; // donation identification number (ISBT 128-style, synthetic)
  type: EventType;
  siteId: string; // where it happened
  actor: string; // who recorded it (pseudonymous user id)
  hlc: string; // hybrid logical clock timestamp, lexicographically sortable
  at: string; // ISO time the event happened in the real world
  origin: string; // node that first recorded it
  payload: Record<string, unknown>;
}

export interface UnitState {
  din: string;
  component: Component;
  bloodGroup: BloodGroup;
  status: UnitStatus;
  siteId: string;
  collectedAt: string;
  expiresAt: string;
  lastEventAt: string;
  patientRef: string | null;
  destinationSiteId: string | null;
  discardReason: string | null;
}

export interface Conflict {
  eventId: string;
  din: string;
  reason: string;
  detectedAt: string;
}
