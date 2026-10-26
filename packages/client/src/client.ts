import { createRegistry, type Mutator } from "@tether/protocol";
import { Store, writeTx } from "./store.js";
import { read, Subscriptions, type Query } from "./subscriptions.js";

export type Mutate<M extends Record<string, Mutator<any>>> = {
  [K in keyof M]: M[K] extends Mutator<infer A>
    ? (args: A) => Promise<void>
    : never;
};

export function createClient<M extends Record<string, Mutator<any>>>(opts: {
  mutators: M;
  userId: string;
}) {
  const store = new Store();
  const subs = new Subscriptions(store);
  const run = createRegistry(Object.values(opts.mutators));
  const ctx = { userId: opts.userId, location: "client" as const };
  let queue: Promise<unknown> = Promise.resolve();

  const mutate = Object.fromEntries(
    Object.entries(opts.mutators).map(([key, m]) => [
      key,
      (args: unknown) => {
        const done = queue.then(async () => {
          const { tx, changes } = writeTx(store);
          await run(tx, m.name, args, ctx);
          subs.notify(store.commit(changes));
        });
        queue = done.catch(() => {});
        return done;
      },
    ]),
  ) as Mutate<M>;

  return {
    mutate,
    read: <T>(fn: Query<T>): T => read(store, fn),
    subscribe: <T>(fn: Query<T>, cb: (value: T) => void) => subs.add(fn, cb),
  };
}

export type Client<M extends Record<string, Mutator<any>>> = ReturnType<
  typeof createClient<M>
>;
