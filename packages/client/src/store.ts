import type { Tx } from "@tether/protocol";

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

export class Store {
  #data = new Map<string, unknown>();

  get(key: string): unknown {
    return this.#data.get(key);
  }

  // shortcut: linear scan + sort per call, upgrade to a sorted index past ~10k keys.
  scan(prefix: string): [string, unknown][] {
    return [...this.#data].filter(([k]) => k.startsWith(prefix)).sort(byKey);
  }

  // `undefined` value deletes. Returns the change set (every key written).
  commit(changes: Map<string, unknown>): Set<string> {
    for (const [k, v] of changes)
      v === undefined ? this.#data.delete(k) : this.#data.set(k, v);
    return new Set(changes.keys());
  }
}

// Buffers writes so a throwing mutator leaves the store untouched.
export function writeTx(store: Store): {
  tx: Tx;
  changes: Map<string, unknown>;
} {
  const changes = new Map<string, unknown>();
  const read = (k: string) => (changes.has(k) ? changes.get(k) : store.get(k));
  const tx: Tx = {
    get: async (k) => read(k),
    has: async (k) => read(k) !== undefined,
    scan: async ({ prefix }) => {
      const merged = new Map(store.scan(prefix));
      for (const [k, v] of changes)
        if (k.startsWith(prefix))
          v === undefined ? merged.delete(k) : merged.set(k, v);
      return [...merged].sort(byKey);
    },
    set: async (k, v) => {
      if (v === undefined)
        throw new TypeError(`set("${k}"): undefined is not a JSON value`);
      changes.set(k, v);
    },
    del: async (k) => void changes.set(k, undefined),
  };
  return { tx, changes };
}
