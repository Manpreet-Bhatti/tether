import { defineMutator } from "@tether/protocol";
import { z } from "zod";

// Every toy mutator takes a unique `uid` so the harness can count executions.
const uid = z.string();
const k = z.string();

const list = async (tx: { get(k: string): Promise<unknown> }) =>
  ((await tx.get("list")) as string[] | undefined) ?? [];

// Generic mutators with no app code: a counter, a list (order-sensitive), a last-writer-wins
// register, a mutator the server can reject, and one only the server rejects.
export const toy = {
  incr: defineMutator(
    "incr@1",
    z.object({ k, by: z.number().int(), uid }),
    async (tx, a) =>
      tx.set(`counter/${a.k}`, ((await tx.get(`counter/${a.k}`)) as number | undefined ?? 0) + a.by),
  ),
  decr: defineMutator("decr@1", z.object({ k, uid }), async (tx, a) => {
    const n = ((await tx.get(`counter/${a.k}`)) as number | undefined) ?? 0;
    if (n <= 0) throw new Error("counter at zero");
    await tx.set(`counter/${a.k}`, n - 1);
  }),
  listInsert: defineMutator(
    "listInsert@1",
    z.object({ at: z.number().int().nonnegative(), v: z.string(), uid }),
    async (tx, a) => {
      const next = [...(await list(tx))];
      next.splice(Math.min(a.at, next.length), 0, a.v);
      await tx.set("list", next);
    },
  ),
  listDelete: defineMutator(
    "listDelete@1",
    z.object({ at: z.number().int().nonnegative(), uid }),
    async (tx, a) => {
      const cur = await list(tx);
      if (cur.length) await tx.set("list", cur.filter((_, i) => i !== a.at % cur.length));
    },
  ),
  lwwSet: defineMutator(
    "lwwSet@1",
    z.object({ k, v: z.number().int(), ts: z.number().int(), uid }),
    async (tx, a) => {
      const cur = (await tx.get(`lww/${a.k}`)) as { v: number; ts: number } | undefined;
      if (cur && (cur.ts > a.ts || (cur.ts === a.ts && cur.v >= a.v))) return;
      await tx.set(`lww/${a.k}`, { v: a.v, ts: a.ts });
    },
  ),
  // Writes, then the server rejects: the client's optimistic write must vanish after the next pull.
  forbidden: defineMutator("forbidden@1", z.object({ k, uid }), async (tx, a, ctx) => {
    await tx.set(`forbidden/${a.k}`, 1);
    if (ctx.location === "server") throw new Error("forbidden");
  }),
};
