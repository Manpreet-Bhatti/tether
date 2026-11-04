import type { PatchOp, Tx } from "@tether/protocol";
import type { PullTxn, PushTxn, ServerStorage } from "./types.js";

interface State {
  version: number;
  minRetained: number;
  entries: Map<string, { value: unknown; scope: string }>;
  log: {
    version: number;
    key: string;
    scope: string;
    op: "put" | "del";
    value?: unknown;
  }[];
  clients: Map<string, { userId: string; lastMutationId: number }>;
}

// Round-trips through JSON like jsonb does, so callers can't alias stored values.
const copy = <T>(v: T): T =>
  v === undefined ? v : JSON.parse(JSON.stringify(v));
const byKey = <T extends { key: string }>(a: T, b: T) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

const memTx = (s: State, version: number): Tx => {
  const record = (key: string, scope: string, op: "put" | "del", value?: unknown) => {
    s.log = s.log.filter(
      (r) => !(r.version === version && r.key === key && r.scope === scope),
    );
    s.log.push({ version, key, scope, op, value });
  };
  return {
    get: async (key) => copy(s.entries.get(key)?.value),
    has: async (key) => s.entries.has(key),
    scan: async ({ prefix }) =>
      [...s.entries]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, e]): [string, unknown] => [k, copy(e.value)]),
    set: async (key, value) => {
      const scope = s.entries.get(key)?.scope ?? "";
      const v = copy(value);
      s.entries.set(key, { value: v, scope });
      record(key, scope, "put", copy(v));
    },
    del: async (key) => {
      const e = s.entries.get(key);
      if (!e) return;
      s.entries.delete(key);
      record(key, e.scope, "del");
    },
  };
};

// shortcut: rollback clones all state per attempt/transaction, fine for test-sized data; use pgStorage beyond that.
export function memoryStorage(): ServerStorage {
  const s: State = {
    version: 0,
    minRetained: 0,
    entries: new Map(),
    log: [],
    clients: new Map(),
  };
  const restore = (saved: State) => Object.assign(s, saved);
  // One operation at a time: stands in for the row lock and snapshot isolation Postgres gives.
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const done = lock.then(fn);
    lock = done.catch(() => {});
    return done;
  };

  const push: PushTxn = {
    lockClient: async (clientId, userId) => {
      if (!s.clients.has(clientId))
        s.clients.set(clientId, { userId, lastMutationId: 0 });
      return { ...s.clients.get(clientId)! };
    },
    setLastMutationId: async (clientId, id) => {
      s.clients.get(clientId)!.lastMutationId = id;
    },
    nextVersion: async () => ++s.version,
    attempt: async (version, fn) => {
      const saved = structuredClone(s);
      try {
        await fn(memTx(s, version));
      } catch (e) {
        restore(saved);
        throw e;
      }
    },
  };

  const pull: PullTxn = {
    head: async (clientId) => ({
      userId: s.clients.get(clientId)?.userId,
      lastMutationId: s.clients.get(clientId)?.lastMutationId ?? 0,
      version: s.version,
      minRetainedVersion: s.minRetained,
    }),
    snapshot: async () =>
      [...s.entries]
        .map(([key, e]) => ({ key, e }))
        .sort(byKey)
        .map(
          ({ key, e }): PatchOp => ({
            op: "put",
            key,
            value: copy(e.value),
            scope: e.scope,
          }),
        ),
    changesSince: async (cookie) => {
      const latest = new Map<string, State["log"][number]>();
      for (const r of s.log)
        if (r.version > cookie && r.version >= (latest.get(r.key)?.version ?? 0))
          latest.set(r.key, r);
      return [...latest.values()].sort(byKey).map(
        (r): PatchOp =>
          r.op === "put"
            ? { op: "put", key: r.key, value: copy(r.value), scope: r.scope }
            : { op: "del", key: r.key },
      );
    },
  };

  return {
    transact: (fn) =>
      exclusive(async () => {
        const saved = structuredClone(s);
        try {
          return await fn(push);
        } catch (e) {
          restore(saved);
          throw e;
        }
      }),
    read: (fn) => exclusive(() => fn(pull)),
    compactLog: (retainVersions) =>
      exclusive(async () => {
        s.minRetained = Math.max(s.minRetained, s.version - retainVersions);
        s.log = s.log.filter((r) => r.version > s.minRetained);
      }),
  };
}
