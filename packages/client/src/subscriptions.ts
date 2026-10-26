import type { Store } from "./store.js";

export interface ReadTx {
  get(key: string): unknown;
  has(key: string): boolean;
  scan(opts: { prefix: string }): [string, unknown][];
}

export type Query<T> = (tx: ReadTx) => T;

interface Sub {
  fn: Query<any>;
  cb: (value: any) => void;
  keys: Set<string>;
  prefixes: Set<string>;
}

export function read<T>(
  store: Store,
  fn: Query<T>,
  keys = new Set<string>(),
  prefixes = new Set<string>(),
): T {
  return fn({
    get: (k) => (keys.add(k), store.get(k)),
    has: (k) => (keys.add(k), store.get(k) !== undefined),
    scan: ({ prefix }) => (prefixes.add(prefix), store.scan(prefix)),
  });
}

export class Subscriptions {
  #subs = new Set<Sub>();
  constructor(private store: Store) {}

  // cb fires only after a write that overlaps what fn read, not on subscribe.
  add<T>(fn: Query<T>, cb: (value: T) => void): () => void {
    const sub: Sub = { fn, cb, keys: new Set(), prefixes: new Set() };
    read(this.store, fn, sub.keys, sub.prefixes);
    this.#subs.add(sub);
    return () => void this.#subs.delete(sub);
  }

  notify(changed: Set<string>): void {
    for (const sub of [...this.#subs]) {
      if (!this.#subs.has(sub)) continue;
      const hit = [...changed].some(
        (k) =>
          sub.keys.has(k) || [...sub.prefixes].some((p) => k.startsWith(p)),
      );
      if (!hit) continue;
      sub.keys.clear();
      sub.prefixes.clear();
      sub.cb(read(this.store, sub.fn, sub.keys, sub.prefixes));
    }
  }
}
