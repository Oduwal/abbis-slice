import type { Store } from '../store/store.ts';
import type { UnitEvent } from '../domain/types.ts';

/**
 * Store-and-forward replication between two nodes.
 *
 * - Each side exposes its log as pages ordered by local `seq`.
 * - A node remembers, per peer, how far it has pulled and pushed, so an
 *   interrupted sync resumes where it stopped instead of starting again.
 * - Imports are idempotent on event id, so resending a page is harmless.
 *   That makes "retry the whole page" the only recovery rule we need on a
 *   flaky link.
 */

export interface PeerTransport {
  pull(since: number, limit: number): Promise<{ events: UnitEvent[]; lastSeq: number; more: boolean }>;
  push(events: UnitEvent[]): Promise<{ imported: number; duplicates: number; conflicts: number }>;
}

export interface SyncReport {
  pulled: number;
  pushed: number;
  conflicts: number;
  error?: string;
}

export async function syncWith(store: Store, peerKey: string, peer: PeerTransport, pageSize = 500): Promise<SyncReport> {
  const report: SyncReport = { pulled: 0, pushed: 0, conflicts: 0 };
  const state = store.peer(peerKey);
  let pulledSeq = state.pulled_seq;
  let pushedSeq = state.pushed_seq;
  try {
    // Pull first: what the peer knows may turn our pending events into conflicts,
    // and we want those surfaced locally before we push.
    for (;;) {
      const page = await peer.pull(pulledSeq, pageSize);
      if (page.events.length) {
        const r = store.importEvents(page.events);
        report.pulled += r.imported;
        report.conflicts += r.conflicts;
      }
      pulledSeq = page.lastSeq;
      store.updatePeer(peerKey, { pulled_seq: pulledSeq, pushed_seq: pushedSeq });
      if (!page.more) break;
    }
    for (;;) {
      const page = store.exportSince(pushedSeq, pageSize);
      if (!page.events.length) break;
      const r = await peer.push(page.events);
      report.pushed += r.imported;
      report.conflicts += r.conflicts;
      pushedSeq = page.lastSeq;
      store.updatePeer(peerKey, { pulled_seq: pulledSeq, pushed_seq: pushedSeq });
      if (!page.more) break;
    }
  } catch (err) {
    report.error = (err as Error).message;
    store.updatePeer(peerKey, { pulled_seq: pulledSeq, pushed_seq: pushedSeq, last_error: report.error });
  }
  return report;
}

/** Peer reachable over HTTP (see /sync/* routes in server.ts). */
export function httpPeer(baseUrl: string, token: string, timeoutMs = 15000): PeerTransport {
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(baseUrl + path, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  };
  return {
    pull: (since, limit) => call(`/sync/events?since=${since}&limit=${limit}`),
    push: (events) => call('/sync/events', { method: 'POST', body: JSON.stringify({ events }) }),
  };
}

/** Peer in the same process, used by tests and the demo. */
export function localPeer(other: Store): PeerTransport {
  return {
    pull: async (since, limit) => other.exportSince(since, limit),
    push: async (events) => other.importEvents(events),
  };
}
