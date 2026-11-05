import { createClient } from "@tether/client";
import type { Mutator } from "@tether/protocol";
import {
  createPullHandler,
  createPushHandler,
  memoryStorage,
  PullError,
  PushError,
  type ServerStorage,
} from "@tether/server";
import { Network, type Handler } from "./network.js";

export const tick = () => new Promise<void>((r) => setImmediate(r));

const watch = <A>(m: Mutator<A>, onRun: (uid: string) => void): Mutator<A> => ({
  ...m,
  fn: (tx, a, ctx) => (onRun((a as { uid: string }).uid), m.fn(tx, a, ctx)),
});

// N clients and one server over a fault-injecting network. Mutator args must carry a unique `uid: string`.
export function createHarness<M extends Record<string, Mutator<any>>>(opts: {
  clients: number;
  mutators: M;
  storage?: ServerStorage;
}) {
  const storage = opts.storage ?? memoryStorage();
  const userId = "u1";
  const applied = new Map<string, number>(); // uid -> times the server ran it
  const issued = new Set<string>(); // uids whose mutate resolved, i.e. entered a push queue
  const confirmed = new Set<string>(); // uids some client has seen confirmed by a pull
  const sent = new Map<string, string>(); // `${clientId}#${mutationId}` -> uid
  const problems: string[] = [];
  const wrap = (onRun: (uid: string) => void) =>
    Object.fromEntries(
      Object.entries(opts.mutators).map(([key, m]) => [key, watch(m, onRun)]),
    ) as M;

  const push = createPushHandler(
    storage,
    Object.values(wrap((uid) => applied.set(uid, (applied.get(uid) ?? 0) + 1))),
  );
  const pull = createPullHandler(storage);
  const handler: Handler = async (url, init) => {
    const body = JSON.parse(String(init.body));
    try {
      if (url.endsWith("/push")) {
        for (const m of body.mutations)
          sent.set(`${body.clientId}#${m.id}`, m.args.uid);
        return Response.json(await push(userId, body));
      }
      return Response.json(await pull(userId, body));
    } catch (e) {
      problems.push(`server ${url}: ${e}`);
      const status = e instanceof PushError || e instanceof PullError ? e.status : 500;
      return new Response(String(e), { status });
    }
  };
  const net = new Network(handler);

  const fetchFor = (id: string): typeof fetch => async (url, init) => {
    const res = await net.fetchFor(id)(url, init);
    if (String(url).endsWith("/pull")) {
      const { lastMutationId } = await res.clone().json();
      for (let n = 1; n <= lastMutationId; n++) {
        const uid = sent.get(`${id}#${n}`);
        if (uid) confirmed.add(uid);
      }
    }
    return res;
  };

  const clients = Array.from({ length: opts.clients }, (_, i) => {
    const clientId = `c${i}`;
    const f = fetchFor(clientId);
    return createClient({
      mutators: wrap((uid) => {
        if (confirmed.has(uid)) problems.push(`confirmed mutation ${uid} replayed`);
      }),
      userId,
      clientId,
      push: {
        url: "http://tether/push",
        fetch: f,
        backoffMs: 0,
        onError: (e) => problems.push(`client ${clientId} push stopped: ${e.message}`),
      },
      pull: { url: "http://tether/pull", fetch: f },
    });
  });

  let n = 0;
  return {
    storage,
    net,
    clients,
    applied,
    issued,
    problems,
    // A mutator that throws on the client never enters the queue, so it is not `issued`.
    async mutate(i: number, name: keyof M & string, args: object) {
      const uid = `m${++n}`;
      try {
        await (clients[i]!.mutate as any)[name]({ ...args, uid });
        issued.add(uid);
      } catch {}
    },
    pull(i: number) {
      clients[i]!.pull().catch(() => {});
    },
    disconnect: (i: number) => net.setUp(`c${i}`, false),
    reconnect: (i: number) => net.setUp(`c${i}`, true),
    // Faults off, then push everything and pull twice: the second pull cannot share a response that predates a push.
    async settle() {
      await net.heal();
      await Promise.all(clients.map((c) => c.flush()));
      for (const c of clients)
        for (let round = 0; round < 2; round++)
          await c.pull().catch((e) => problems.push(`settle pull: ${e}`));
      await tick();
    },
  };
}

export type Harness = ReturnType<typeof createHarness<any>>;
