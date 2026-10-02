import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventType, Role } from './domain/types.ts';

/**
 * Stateless signed tokens + role- and site-scoped permissions.
 *
 * In a pilot this sits behind the national identity provider (OIDC); the
 * token format and the permission checks below stay the same. Demo users are
 * synthetic and exist only so judges can switch roles.
 */

export interface Principal {
  sub: string;
  name: string;
  role: Role;
  siteId: string | null; // null = not tied to one site (admin, sync peer)
  exp: number;
}

const SECRET = process.env.TOKEN_SECRET ?? 'dev-only-secret-change-me';
if (!process.env.TOKEN_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('TOKEN_SECRET must be set in production');
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function sign(p: Omit<Principal, 'exp'>, ttlSeconds = 8 * 3600): string {
  const body = b64(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const mac = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify(token: string | undefined): Principal | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', SECRET).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as Principal;
  return p.exp > Date.now() / 1000 ? p : null;
}

const EVENT_PERMISSIONS: Record<Role, EventType[]> = {
  lab_tech: ['COLLECTED', 'TESTED', 'DISCARDED'],
  inventory_officer: ['RESERVED', 'DISPATCHED', 'RECEIVED', 'DISCARDED'],
  clinician: ['RESERVED', 'ISSUED', 'TRANSFUSED', 'RETURNED'],
  admin: ['COLLECTED', 'TESTED', 'RESERVED', 'DISPATCHED', 'RECEIVED', 'ISSUED', 'TRANSFUSED', 'RETURNED', 'DISCARDED'],
  sync_peer: [],
  donor: [],
};

export type Action = 'read' | 'approve_suggestion' | 'resolve_conflict' | 'sync' | 'record_demand' | 'manage_appeals' | 'checkin' | 'donor';

const ACTION_PERMISSIONS: Record<Action, Role[]> = {
  read: ['lab_tech', 'inventory_officer', 'clinician', 'admin'],
  approve_suggestion: ['inventory_officer', 'admin'],
  resolve_conflict: ['inventory_officer', 'admin'],
  sync: ['sync_peer', 'admin'],
  record_demand: ['clinician', 'admin'],
  manage_appeals: ['inventory_officer', 'clinician', 'admin'],
  checkin: ['lab_tech', 'inventory_officer', 'admin'],
  donor: ['donor'],
};

export function canRecord(p: Principal, type: EventType, siteId: string): string | null {
  if (!EVENT_PERMISSIONS[p.role].includes(type)) return `role ${p.role} may not record ${type}`;
  if (p.siteId && p.siteId !== siteId) return `user is assigned to ${p.siteId}, not ${siteId}`;
  return null;
}

export function can(p: Principal, action: Action, siteId?: string): string | null {
  if (!ACTION_PERMISSIONS[action].includes(p.role)) return `role ${p.role} may not ${action.replace('_', ' ')}`;
  if (siteId && p.siteId && p.siteId !== siteId) return `user is assigned to ${p.siteId}, not ${siteId}`;
  return null;
}
