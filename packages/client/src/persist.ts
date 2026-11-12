import type { Mutation, PatchOp } from "@tether/protocol";
import { deleteDB, openDB, type IDBPDatabase, type IDBPTransaction } from "idb";

export interface Saved {
  clientId: string;
  schemaVersion: number;
  cookie: number | null;
  nextId: number;
  base: [string, unknown][];
  pending: Mutation[];
}

const STORES = ["base", "pending", "meta"];
type Op = (tx: IDBPTransaction<unknown, string[], "readwrite">) => unknown;

// IndexedDB mirror of the leader's confirmed state (`base`), unconfirmed mutations (`pending`,
// keyed by id) and bookkeeping (`meta`). Writes made in the same tick share one transaction and
// run after it, so they never sit on the render path.
export class Persist {
  #db?: Promise<IDBPDatabase>;
  #ops: Op[] = [];
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    readonly name: string,
    private onError: (e: unknown) => void = console.error,
  ) {}

  #open() {
    return (this.#db ??= openDB(this.name, 1, {
      upgrade: (db) => STORES.forEach((s) => db.createObjectStore(s)),
      blocking: () => void this.close(), // another tab is deleting this database (logout)
    }));
  }

  // A broken IndexedDB (private window) loses offline support, not the app: report and start empty.
  async load(): Promise<Saved | undefined> {
    return this.#read().catch((e) => void this.onError(e));
  }

  async #read(): Promise<Saved | undefined> {
    const tx = (await this.#open()).transaction(STORES);
    const meta = (k: string) => tx.objectStore("meta").get(k);
    const [clientId, schemaVersion, cookie, nextId, keys, values, pending] =
      await Promise.all([
        meta("clientId"),
        meta("schemaVersion"),
        meta("cookie"),
        meta("nextId"),
        tx.objectStore("base").getAllKeys(),
        tx.objectStore("base").getAll(),
        tx.objectStore("pending").getAll(),
      ]);
    if (clientId === undefined) return undefined;
    return {
      clientId,
      schemaVersion,
      cookie: cookie ?? null,
      nextId: Math.max(nextId ?? 1, (pending.at(-1)?.id ?? 0) + 1), // getAll is in key (id) order
      base: keys.map((k, i) => [k as string, values[i]]),
      pending,
    };
  }

  #write(op: Op): void {
    if (this.#closed) return;
    if (this.#ops.push(op) === 1)
      queueMicrotask(
        () => (this.#chain = this.#chain.then(() => this.#flush())),
      );
  }

  async #flush(): Promise<void> {
    const ops = this.#ops.splice(0);
    if (!ops.length) return;
    try {
      const tx = (await this.#open()).transaction(STORES, "readwrite");
      await Promise.all([...ops.map((op) => op(tx)), tx.done]);
    } catch (e) {
      this.onError(e);
    }
  }

  // First run on this database, or the app's schemaVersion changed (stored base is stale).
  init(clientId: string, schemaVersion: number): void {
    this.#write((tx) =>
      Promise.all([
        tx.objectStore("base").clear(),
        tx.objectStore("meta").put(clientId, "clientId"),
        tx.objectStore("meta").put(schemaVersion, "schemaVersion"),
        tx.objectStore("meta").put(null, "cookie"),
      ]),
    );
  }

  queued(m: Mutation): void {
    this.#write((tx) =>
      Promise.all([
        tx.objectStore("pending").put(m, m.id),
        tx.objectStore("meta").put(m.id + 1, "nextId"),
      ]),
    );
  }

  pulled(patch: PatchOp[], cookie: number, lastMutationId: number): void {
    this.#write((tx) => {
      const base = tx.objectStore("base");
      return Promise.all([
        ...patch.map((p) =>
          p.op === "clear"
            ? base.clear()
            : p.op === "put"
              ? base.put(p.value, p.key)
              : base.delete(p.key),
        ),
        tx.objectStore("meta").put(cookie, "cookie"),
        tx
          .objectStore("pending")
          .delete(IDBKeyRange.upperBound(lastMutationId)),
      ]);
    });
  }

  // Drops queued writes and the connection. Safe to call twice.
  async close(): Promise<void> {
    this.#closed = true;
    this.#ops.length = 0;
    await this.#chain;
    await (await this.#db?.catch(() => undefined))?.close();
  }

  async destroy(): Promise<void> {
    await this.close();
    await deleteDB(this.name);
  }
}
