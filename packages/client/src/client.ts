import { createRegistry, PullResponse, type Mutator } from "@tether/protocol";
import { Store, writeTx } from "./store.js";
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
  clientId?: string;
}) {
  const store = new Store();
  const base = new Store();
  let cookie: number | null = null;
  const subs = new Subscriptions(store);
  const run = createRegistry(Object.values(opts.mutators));
  const ctx = { userId: opts.userId, location: "client" as const };
  const clientId = opts.clientId ?? crypto.randomUUID();
  const pusher = opts.push && new Pusher(clientId, opts.push);
  let queue: Promise<unknown> = Promise.resolve();
  // Mutations and rebases run one at a time so a replay never interleaves with a write.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const done = queue.then(fn);
    queue = done.catch(() => {});
    return done;
  };

  const doPull = async () => {
    const { url, headers, fetch: send = fetch } = opts.pull!;
    const res = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ clientId, cookie, scopes: [] }),
    });
    if (!res.ok)
      throw new Error(`pull failed: ${res.status} ${await res.text()}`);
    const r = PullResponse.parse(await res.json());
    await serial(async () => {
      applyPatch(base, r.patch);
      cookie = r.cookie;
      pusher?.confirm(r.lastMutationId);
      const view = await rebase(base, pusher?.pending ?? [], run, ctx);
      subs.notify(store.replace(view));
    });
  };
  let pulling: Promise<void> | undefined;

  const mutate = Object.fromEntries(
    Object.entries(opts.mutators).map(([key, m]) => [
      key,
      (args: unknown) =>
        serial(async () => {
          const { tx, changes } = writeTx(store);
          await run(tx, m.name, args, ctx);
          const changed = store.commit(changes);
          pusher?.enqueue(m.name, args);
          subs.notify(changed);
        }),
    ]),
  ) as Mutate<M>;

  return {
    mutate,
    flush: () => pusher?.flush() ?? Promise.resolve(),
    // Calls during a pull share it: that response may predate the caller's own push.
    pull: () =>
      opts.pull
        ? (pulling ??= doPull().finally(() => (pulling = undefined)))
        : Promise.resolve(),
    read: <T>(fn: Query<T>): T => read(store, fn),
    subscribe: <T>(fn: Query<T>, cb: (value: T) => void) => subs.add(fn, cb),
  };
}

export type Client<M extends Record<string, Mutator<any>>> = ReturnType<
  typeof createClient<M>
>;
