/**
 * Hybrid logical clock (Kulkarni et al., 2014).
 *
 * Gives every event a timestamp that (a) stays close to wall-clock time,
 * (b) never goes backwards on a node even if its clock does, and
 * (c) is always greater than any timestamp the node has already seen from
 * a peer. Encoded as a fixed-width string so that ordinary string
 * comparison gives a total order: "<ms:15>-<counter:6>-<nodeId>".
 */
export class HLC {
  private ms = 0;
  private counter = 0;
  readonly nodeId: string;
  private readonly now: () => number;

  constructor(nodeId: string, now: () => number = Date.now) {
    if (!nodeId) throw new Error('nodeId required');
    this.nodeId = nodeId;
    this.now = now;
  }

  /** Timestamp for a local event. `physical` lets the simulator back-date events. */
  tick(physical: number = this.now()): string {
    if (physical > this.ms) {
      this.ms = physical;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return encode(this.ms, this.counter, this.nodeId);
  }

  /** Merge a timestamp received from a peer. */
  receive(remote: string): void {
    const r = decode(remote);
    const physical = this.now();
    const maxMs = Math.max(this.ms, r.ms, physical);
    if (maxMs === this.ms && maxMs === r.ms) this.counter = Math.max(this.counter, r.counter) + 1;
    else if (maxMs === this.ms) this.counter++;
    else if (maxMs === r.ms) this.counter = r.counter + 1;
    else this.counter = 0;
    this.ms = maxMs;
  }
}

export function encode(ms: number, counter: number, nodeId: string): string {
  return `${String(ms).padStart(15, '0')}-${String(counter).padStart(6, '0')}-${nodeId}`;
}

export function decode(hlc: string): { ms: number; counter: number; nodeId: string } {
  const [ms, counter, ...rest] = hlc.split('-');
  return { ms: Number(ms), counter: Number(counter), nodeId: rest.join('-') };
}
