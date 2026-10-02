import type { BloodGroup, Component, UnitEvent, UnitState } from './types.ts';

/**
 * The unit lifecycle as a pure state machine.
 *
 * State is never edited directly: it is always the result of replaying the
 * unit's events in HLC order. An event that is not valid at its position in
 * the merged log (for example, the same unit issued at two hospitals while
 * both were offline) is kept in the log for audit but NOT applied, and is
 * reported as a conflict for a human to resolve.
 */

export interface Rejection {
  event: UnitEvent;
  reason: string;
}

export interface ReplayResult {
  state: UnitState | null;
  rejected: Rejection[];
}

const TERMINAL = new Set(['transfused', 'discarded']);

export function compareEvents(a: UnitEvent, b: UnitEvent): number {
  if (a.hlc < b.hlc) return -1;
  if (a.hlc > b.hlc) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Returns a reason string if the event cannot be applied, else null. */
export function validate(state: UnitState | null, e: UnitEvent): string | null {
  if (e.type === 'COLLECTED') {
    if (state) return 'unit already collected (duplicate DIN)';
    const p = e.payload;
    if (!p.component || !p.bloodGroup || !p.expiresAt) return 'COLLECTED requires component, bloodGroup, expiresAt';
    return null;
  }
  if (!state) return 'unit has no COLLECTED event yet';
  if (TERMINAL.has(state.status)) return `unit is already ${state.status}`;

  const expired = e.at >= state.expiresAt;
  const atCurrentSite = e.siteId === state.siteId;

  switch (e.type) {
    case 'TESTED':
      if (state.status !== 'quarantine') return `cannot test a unit that is ${state.status}`;
      if (e.payload.result !== 'negative' && e.payload.result !== 'reactive') return 'TESTED requires result negative|reactive';
      return null;
    case 'RESERVED':
      if (state.status !== 'available') return `cannot reserve a unit that is ${state.status}`;
      if (!atCurrentSite) return `unit is held at ${state.siteId}, not ${e.siteId}`;
      if (expired) return 'unit expired';
      if (!e.payload.patientRef) return 'RESERVED requires patientRef';
      return null;
    case 'DISPATCHED':
      if (state.status !== 'available') return `cannot dispatch a unit that is ${state.status}`;
      if (!atCurrentSite) return `unit is held at ${state.siteId}, not ${e.siteId}`;
      if (expired) return 'unit expired';
      if (!e.payload.toSiteId || e.payload.toSiteId === e.siteId) return 'DISPATCHED requires a different toSiteId';
      return null;
    case 'RECEIVED':
      if (state.status !== 'in_transit') return `cannot receive a unit that is ${state.status}`;
      if (e.siteId !== state.destinationSiteId) return `unit was dispatched to ${state.destinationSiteId}, not ${e.siteId}`;
      return null;
    case 'ISSUED':
      if (state.status !== 'available' && state.status !== 'reserved') return `cannot issue a unit that is ${state.status}`;
      if (!atCurrentSite) return `unit is held at ${state.siteId}, not ${e.siteId}`;
      if (expired) return 'unit expired';
      if (!e.payload.patientRef) return 'ISSUED requires patientRef';
      if (state.status === 'reserved' && state.patientRef !== e.payload.patientRef) return 'unit is reserved for a different patient';
      return null;
    case 'TRANSFUSED':
      if (state.status !== 'issued') return `cannot transfuse a unit that is ${state.status}`;
      return null;
    case 'RETURNED':
      if (state.status !== 'issued') return `cannot return a unit that is ${state.status}`;
      return null;
    case 'DISCARDED':
      if (!e.payload.reason) return 'DISCARDED requires reason';
      return null;
    default:
      return `unknown event type ${(e as UnitEvent).type}`;
  }
}

export function apply(state: UnitState | null, e: UnitEvent): UnitState {
  if (e.type === 'COLLECTED') {
    const p = e.payload;
    return {
      din: e.din,
      component: p.component as Component,
      bloodGroup: p.bloodGroup as BloodGroup,
      status: 'quarantine',
      siteId: e.siteId,
      collectedAt: e.at,
      expiresAt: String(p.expiresAt),
      lastEventAt: e.at,
      patientRef: null,
      destinationSiteId: null,
      discardReason: null,
    };
  }
  const s: UnitState = { ...(state as UnitState), lastEventAt: e.at };
  switch (e.type) {
    case 'TESTED':
      if (e.payload.result === 'negative') s.status = 'available';
      else {
        s.status = 'discarded';
        s.discardReason = 'TTI screen reactive';
      }
      break;
    case 'RESERVED':
      s.status = 'reserved';
      s.patientRef = String(e.payload.patientRef);
      break;
    case 'DISPATCHED':
      s.status = 'in_transit';
      s.destinationSiteId = String(e.payload.toSiteId);
      break;
    case 'RECEIVED':
      s.status = 'available';
      s.siteId = e.siteId;
      s.destinationSiteId = null;
      break;
    case 'ISSUED':
      s.status = 'issued';
      s.patientRef = String(e.payload.patientRef);
      break;
    case 'TRANSFUSED':
      s.status = 'transfused';
      break;
    case 'RETURNED':
      if (e.payload.coldChainOk === false) {
        s.status = 'discarded';
        s.discardReason = 'returned outside cold chain';
      } else {
        s.status = 'available';
        s.patientRef = null;
      }
      break;
    case 'DISCARDED':
      s.status = 'discarded';
      s.discardReason = String(e.payload.reason);
      break;
  }
  return s;
}

export function replay(events: UnitEvent[]): ReplayResult {
  const sorted = [...events].sort(compareEvents);
  let state: UnitState | null = null;
  const rejected: Rejection[] = [];
  for (const e of sorted) {
    const reason = validate(state, e);
    if (reason) rejected.push({ event: e, reason });
    else state = apply(state, e);
  }
  return { state, rejected };
}
