import type { Tx } from "@tether/protocol";

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => deepEqual((a as any)[k], (b as any)[k]))
  );
};

export class Store {
  #data: Map<string, unknown>;

  constructor(data?: Iterable<[string, unknown]>) {
    this.#data = new Map(data);
  }

  clone(): Store {
    return new Store(this.#data);
  }

  clear(): void {
    this.#data.clear();
  }

  // Takes over `next`'s contents (and leaves `next` unusable). Returns keys whose value differs.
  replace(next: Store): Set<string> {
    const changed = new Set<string>();
    for (const [k, v] of next.#data)
      if (!deepEqual(this.#data.get(k), v)) changed.add(k);
    for (const k of this.#data.keys()) if (!next.#data.has(k)) changed.add(k);
    this.#data = next.#data;
    return changed;
  }

  get(key: string): unknown {
    return this.#data.get(key);
  }

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
