import "fake-indexeddb/auto";
import { defineMutator } from "@tether/protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClient } from "../src/index.js";
import { Persist } from "../src/persist.js";

const set = defineMutator(
  "set@1",
  z.object({ k: z.string(), v: z.number() }),
  (tx, a) => tx.set(a.k, a.v),
);
const mutators = { set };
const json = (b: unknown) =>
  new Response(JSON.stringify(b), {
    headers: { "content-type": "application/json" },
  });

let n = 0;
const dbName = () => `test-${++n}`;
const down = (async () => {
  throw new TypeError("offline");
}) as unknown as typeof fetch;
const expectNoDb = async (name: string) =>
  expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(name);
const idle = () => new Promise<void>((r) => setTimeout(r, 20)); // lets the batched IDB write land

// A server that applies `set` pushes and reports them on pull.
function server() {
  const state: Record<string, number> = {};
  let last = 0;
  const seen: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/push")) {
      for (const m of body.mutations) {
        if (m.id <= last) continue;
        seen.push(m.id);
        state[m.args.k] = m.args.v;
        last = m.id;
      }
      return json({ results: [] });
    }
    return json({
      cookie: last,
      lastMutationId: last,
      patch: [
        { op: "clear" },
        ...Object.entries(state).map(([key, value]) => ({
          op: "put",
          key,
          value,
          scope: "",
        })),
      ],
    });
  }) as typeof fetch;
  return { fetch, state, seen };
}

const make = (name: string, fetch: typeof globalThis.fetch, extra = {}) =>
  createClient({
    mutators,
    userId: "u",
    push: { url: "http://x/push", fetch, backoffMs: 1 },
    pull: { url: "http://x/pull", fetch },
    persist: { name },
    ...extra,
  });

describe("persist", () => {
  it("offline edits survive a reload and reach the server once", async () => {
    const name = dbName();
    const a = make(name, down);
    await a.mutate.set({ k: "a", v: 1 });
    await a.mutate.set({ k: "b", v: 2 });
    await idle();
    a.close();

    const s = server();
    const b = make(name, down);
    await b.pull().catch(() => {});
    await b.mutate.set({ k: "c", v: 3 }); // waits for restore, then gets id 3
    expect(b.read((r) => r.get("a"))).toBe(1);
    expect(b.read((r) => r.get("b"))).toBe(2);
    await idle();
    b.close();

    const c = make(name, s.fetch);
    await c.pull();
    await c.flush();
    expect(s.seen).toEqual([1, 2, 3]);
    await c.pull();
    expect(s.state).toEqual({ a: 1, b: 2, c: 3 });
    expect(c.read((r) => r.scan({ prefix: "" }).length)).toBe(3);
    c.close();
  });

  it("restores confirmed state and cookie without a network", async () => {
    const name = dbName();
    const s = server();
    const a = make(name, s.fetch);
    await a.mutate.set({ k: "x", v: 9 });
    await a.flush();
    await a.pull();
    await idle();
    a.close();

    const b = make(name, down);
    await b.flush(); // waits for restore
    expect(b.read((r) => r.get("x"))).toBe(9);
    b.close();
  });

  it("never reuses ids the server already holds when local storage lost them", async () => {
    const name = dbName();
    const s = server();
    const a = make(name, s.fetch);
    await a.mutate.set({ k: "a", v: 1 });
    await a.flush();
    a.close();
    await idle();
    // Simulate lost IDB writes: the next client starts from nextId 1 but the server is at 1.
    const p = new Persist(name);
    await p.destroy();
    const b = make(name, s.fetch);
    await b.pull(); // server says lastMutationId 1
    await b.mutate.set({ k: "b", v: 2 });
    await b.flush();
    expect(s.state.b).toBe(2);
    b.close();
  });

  it("logout deletes the database", async () => {
    const name = dbName();
    const a = make(name, down);
    await a.mutate.set({ k: "a", v: 1 });
    await idle();
    await a.logout();
    expect(a.read((r) => r.get("a"))).toBeUndefined();
    await expectNoDb(name);
  });

  it("resetRequired from the server wipes local data and calls onReset", async () => {
    const name = dbName();
    let reset = 0;
    const a = make(name, (async () => json({ results: [], resetRequired: true })) as unknown as typeof fetch, {
      onReset: () => reset++,
    });
    await a.mutate.set({ k: "a", v: 1 });
    await expect.poll(() => reset).toBe(1);
    await expectNoDb(name);
  });

  it("ignores persist without Web Locks, so tabs never share a client id", async () => {
    vi.stubGlobal("navigator", {});
    try {
      const applied: string[] = [];
      const last = new Map<string, number>();
      const fetch = (async (_u: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body));
        for (const m of b.mutations)
          if (m.id > (last.get(b.clientId) ?? 0)) {
            applied.push(m.args.k);
            last.set(b.clientId, m.id);
          }
        return json({ results: [] });
      }) as typeof globalThis.fetch;
      const name = dbName();
      const [a, b] = [make(name, fetch), make(name, fetch)];
      await a.mutate.set({ k: "a1", v: 1 });
      await b.mutate.set({ k: "b1", v: 1 });
      await Promise.all([a.flush(), b.flush()]);
      expect(applied.sort()).toEqual(["a1", "b1"]);
      await expectNoDb(name);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
