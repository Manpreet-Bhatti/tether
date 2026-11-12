import {
  createRegistry,
  PullResponse,
  type Mutation,
  type Mutator,
} from "@tether/protocol";
import { Store, writeTx } from "./store.js";
import { HttpError, REQUEST_TIMEOUT_MS } from "./net.js";
import { Persist, type Saved } from "./persist.js";
import { connectPoke, type PokeOpts } from "./poke.js";
import { Pusher, type PushOpts } from "./pusher.js";
import { applyPatch, rebase } from "./rebase.js";
import { read, Subscriptions, type Query } from "./subscriptions.js";

export type Mutate<M extends Record<string, Mutator<any>>> = {
  [K in keyof M]: M[K] extends Mutator<infer A>
    ? (args: A) => Promise<void>
    : never;
};

export function createClient<M extends Record<string, Mutator<any>>>(opts: {
  mutators: M;
  userId: string;
  push?: PushOpts;
  pull?: Pick<PushOpts, "url" | "headers" | "fetch">;
  poke?: PokeOpts;
  clientId?: string;
  // Keeps confirmed state and the unsent queue in IndexedDB (needs `push`). One tab per database
  // holds the `navigator.locks` lock and does all networking; other tabs forward mutations to it.
  persist?: { name: string; onError?: (e: unknown) => void };
  // The server rejected this schemaVersion. Local data is already gone; reload for new code.
  onReset?: () => void;
}) {
  const store = new Store();
  const base = new Store();
  let cookie: number | null = null;
  const subs = new Subscriptions(store);
  const run = createRegistry(Object.values(opts.mutators));
  const ctx = { userId: opts.userId, location: "client" as const };
  const schemaVersion = opts.push?.schemaVersion ?? 1;
  let clientId = opts.clientId ?? crypto.randomUUID();
  let pusher: Pusher | undefined;
  let stopPoke: (() => void) | undefined;
  let release: (() => void) | undefined;
  let leading = false;
  let queue: Promise<unknown> = Promise.resolve();
  // Mutations and rebases run one at a time so a replay never interleaves with a write.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const done = queue.then(fn);
    queue = done.catch(() => {});
    return done;
  };

  // Web Locks is what keeps two tabs from sharing one client id, so without it (old browsers,
  // plain http off localhost) `persist` is ignored: every tab then has its own in-memory id.
  const tabbed = globalThis.navigator?.locks && opts.persist;
  const persist = tabbed && new Persist(tabbed.name, tabbed.onError);
  const chan = tabbed && new BroadcastChannel(tabbed.name);
  const post = (m: object) => chan?.postMessage(m);
  // Every view change on the leader reaches this tab's subscribers and the follower tabs.
  const publish = (changed: Set<string>) => {
    subs.notify(changed);
    if (chan && changed.size)
      post({ t: "diff", entries: [...changed].map((k) => [k, store.get(k)]) });
  };

  const doPull = async () => {
    const { url, headers, fetch: send = fetch } = opts.pull!;
    const res = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ clientId, cookie, scopes: [] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok)
      throw new HttpError(
        res.status,
        `pull failed: ${res.status} ${await res.text()}`,
      );
    const r = PullResponse.parse(await res.json());
    await serial(async () => {
      applyPatch(base, r.patch);
      cookie = r.cookie;
      pusher?.confirm(r.lastMutationId);
      persist?.pulled(r.patch, r.cookie, r.lastMutationId);
      const view = await rebase(base, pusher?.pending ?? [], run, ctx);
      publish(store.replace(view));
    });
  };
  let pulling: Promise<void> | undefined;
  const sharedPull = () =>
    (pulling ??= doPull().finally(() => (pulling = undefined)));

  // Becomes the tab that owns the network: restores saved state, then starts pushing and pulling.
  const start = async (saved?: Saved) => {
    if (saved) clientId = saved.clientId;
    if (saved?.schemaVersion === schemaVersion) {
      base.commit(new Map(saved.base));
      cookie = saved.cookie;
    } else persist?.init(clientId, schemaVersion); // stale or no base: refetch. Pending still goes out.
    pusher =
      opts.push &&
      new Pusher(
        clientId,
        { ...opts.push, onReset: () => void reset() },
        saved,
      );
    if (saved)
      publish(
        store.replace(await rebase(base, pusher?.pending ?? [], run, ctx)),
      );
    stopPoke =
      opts.pull && opts.poke
        ? connectPoke(opts.poke, async () => {
            await pulling?.catch(() => {});
            await sharedPull();
          })
        : undefined;
    leading = true;
  };

  // Leader: apply a mutation to the view and queue it for the server.
  const local = (name: string, args: unknown) =>
    serial(async () => {
      const { tx, changes } = writeTx(store);
      await run(tx, name, args, ctx);
      const changed = store.commit(changes);
      const queued = pusher?.enqueue(name, args);
      if (queued) persist?.queued(queued);
      publish(changed);
    });

  // Follower: the leader applies it; the result comes back as an ack and a diff.
  const waiting = new Map<
    string,
    {
      name: string;
      args: unknown;
      resolve: () => void;
      reject: (e: Error) => void;
    }
  >();
  const forward = (name: string, args: unknown) =>
    new Promise<void>((resolve, reject) => {
      const rid = crypto.randomUUID();
      waiting.set(rid, { name, args, resolve, reject });
      post({ t: "mutate", rid, name, args });
    });

  let settle!: () => void;
  const ready = persist
    ? new Promise<void>((r) => (settle = r))
    : Promise.resolve();

  const lead = async () => {
    await start(await persist!.load());
    // shortcut: a mutation sent to a leader that died after queueing it runs twice.
    for (const [rid, w] of waiting) {
      waiting.delete(rid);
      local(w.name, w.args).then(w.resolve, w.reject);
    }
    post({ t: "leader" });
    settle();
  };

  let closed = false;
  const teardown = () => {
    closed = true;
    stopPoke?.();
    pusher?.stop();
    release?.();
    leading = false;
    chan?.close();
    void persist?.close();
  };
  const wipe = () => {
    teardown();
    subs.notify(store.replace(new Store()));
  };
  const logout = async () => {
    post({ t: "logout" });
    wipe();
    await persist?.destroy();
  };
  const reset = async () => {
    await logout();
    opts.onReset?.();
  };

  if (chan)
    chan.onmessage = ({ data: m }) => {
      if (m.t === "logout") wipe();
      else if (leading) {
        if (m.t === "hello") post({ t: "snapshot", entries: store.scan("") });
        else if (m.t === "mutate")
          local(m.name, m.args).then(
            () => post({ t: "ack", rid: m.rid }),
            (e) =>
              post({ t: "ack", rid: m.rid, error: String(e?.message ?? e) }),
          );
      } else if (m.t === "snapshot") {
        subs.notify(store.replace(new Store(m.entries)));
        settle();
      } else if (m.t === "diff") subs.notify(store.commit(new Map(m.entries)));
      else if (m.t === "ack") {
        const w = waiting.get(m.rid);
        waiting.delete(m.rid);
        m.error === undefined ? w?.resolve() : w?.reject(new Error(m.error));
      } else if (m.t === "leader") {
        post({ t: "hello" });
        for (const [rid, w] of waiting)
          post({ t: "mutate", rid, name: w.name, args: w.args });
      }
    };

  if (!persist) void start();
  else {
    const lock = `${persist.name}:leader`;
    // Holding the lock = leading. It frees itself when the tab dies, so a waiting tab takes over.
    const hold = async () => {
      await lead();
      await new Promise<void>((r) => (release = r));
    };
    const { locks } = navigator;
    void locks.request(lock, { ifAvailable: true }, async (got) => {
      if (got) return hold();
      post({ t: "hello" });
      const waitingForLock = new AbortController();
      release = () => waitingForLock.abort();
      locks
        .request(lock, { signal: waitingForLock.signal }, hold)
        .catch(() => {}); // aborted by close()
    });
  }

  const mutate = Object.fromEntries(
    Object.entries(opts.mutators).map(([key, m]) => [
      key,
      (args: unknown) =>
        closed
          ? Promise.reject(new Error("client closed"))
          : leading
            ? local(m.name, args)
            : ready.then(() =>
                leading ? local(m.name, args) : forward(m.name, args),
              ),
    ]),
  ) as Mutate<M>;

  return {
    mutate,
    // Followers have nothing to flush or pull: the leader tab does both.
    flush: async () => {
      await ready;
      await pusher?.flush();
    },
    pull: async () => {
      await ready;
      if (leading && opts.pull) await sharedPull();
    },
    close: teardown,
    // Stops syncing and deletes everything stored locally, in every tab.
    logout,
    read: <T>(fn: Query<T>): T => read(store, fn),
    subscribe: <T>(fn: Query<T>, cb: (value: T) => void) => subs.add(fn, cb),
  };
}

export type Client<M extends Record<string, Mutator<any>>> = ReturnType<
  typeof createClient<M>
>;
