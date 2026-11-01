import { createRegistry, defineMutator } from "@tether/protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClient } from "../src/index.js";
import { Store, writeTx } from "../src/store.js";

const set = defineMutator(
  "set@1",
  z.object({ k: z.string(), v: z.number() }),
  (tx, a) => tx.set(a.k, a.v),
);
const del = defineMutator("del@1", z.object({ k: z.string() }), (tx, a) =>
  tx.del(a.k),
);
const boom = defineMutator("boom@1", z.object({}), async (tx) => {
  await tx.set("half", 1);
  throw new Error("boom");
});
const mutators = { set, del, boom };
const ctx = { userId: "u", location: "client" as const };

describe("store", () => {
  it("get/scan/set/del see their own writes; commit reports changed keys", async () => {
    const store = new Store();
    const { tx, changes } = writeTx(store);
    await tx.set("a/2", 2);
    await tx.set("a/1", 1);
    await tx.set("b/1", 3);
    expect(await tx.scan({ prefix: "a/" })).toEqual([
      ["a/1", 1],
      ["a/2", 2],
    ]);
    expect(store.get("a/1")).toBeUndefined(); // not committed yet
    expect(store.commit(changes)).toEqual(new Set(["a/2", "a/1", "b/1"]));
    const w2 = writeTx(store);
    await w2.tx.del("a/1");
    expect(await w2.tx.has("a/1")).toBe(false);
    expect(await w2.tx.scan({ prefix: "a/" })).toEqual([["a/2", 2]]);
    store.commit(w2.changes);
    expect(store.scan("a/")).toEqual([["a/2", 2]]);
  });

  it("rejects undefined values", async () => {
    await expect(writeTx(new Store()).tx.set("k", undefined)).rejects.toThrow(
      TypeError,
    );
  });
});

describe("registry", () => {
  const run = createRegistry([set]);
  it("unknown name throws", async () => {
    await expect(
      run(writeTx(new Store()).tx, "nope@1", {}, ctx),
    ).rejects.toThrow("unknown mutator: nope@1");
  });
  it("Zod rejects bad args", async () => {
    await expect(
      run(writeTx(new Store()).tx, "set@1", { k: "a", v: "x" }, ctx),
    ).rejects.toThrow();
  });
});

describe("client", () => {
  it("mutate updates reads; failed mutator leaves no trace", async () => {
    const c = createClient({ mutators, userId: "u" });
    await c.mutate.set({ k: "a", v: 1 });
    expect(c.read((tx) => tx.get("a"))).toBe(1);
    await expect(c.mutate.boom({})).rejects.toThrow("boom");
    expect(c.read((tx) => tx.has("half"))).toBe(false);
    await expect(c.mutate.set({ k: "a", v: "bad" as never })).rejects.toThrow();
  });

  it("concurrent mutations apply in call order", async () => {
    const c = createClient({ mutators, userId: "u" });
    await Promise.all([
      c.mutate.set({ k: "a", v: 1 }),
      c.mutate.set({ k: "a", v: 2 }),
      c.mutate.del({ k: "b" }),
    ]);
    expect(c.read((tx) => tx.get("a"))).toBe(2);
  });

  it("subscription reruns only when its reads overlap the change set", async () => {
    const c = createClient({ mutators, userId: "u" });
    const query = vi.fn(
      (tx) => tx.scan({ prefix: "issue/" }).length + (tx.get("flag") ? 100 : 0),
    );
    const cb = vi.fn();
    const off = c.subscribe(query, cb);
    expect(query).toHaveBeenCalledTimes(1);

    await c.mutate.set({ k: "other/1", v: 1 }); // unrelated
    expect(query).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();

    await c.mutate.set({ k: "issue/1", v: 1 }); // prefix hit
    expect(cb).toHaveBeenLastCalledWith(1);
    await c.mutate.set({ k: "flag", v: 1 }); // key hit
    expect(cb).toHaveBeenLastCalledWith(101);
    expect(query).toHaveBeenCalledTimes(3);

    off();
    await c.mutate.set({ k: "issue/2", v: 1 });
    expect(query).toHaveBeenCalledTimes(3);
  });
});

describe("pull and rebase", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body));
  const setup = (next: () => object) => {
    const run = vi.fn();
    const counted = defineMutator(
      "set@1",
      z.object({ k: z.string(), v: z.number() }),
      async (tx, a) => (run(), tx.set(a.k, a.v)),
    );
    const fetch = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u).endsWith("/pull")) return json(next());
      const { mutations } = JSON.parse(String(init!.body));
      return json({
        results: mutations.map((m: { id: number }) => ({ id: m.id })),
      });
    });
    const c = createClient({
      mutators: { set: counted },
      userId: "u",
      push: { url: "http://x/push", fetch },
      pull: { url: "http://x/pull", fetch },
    });
    return { c, run, fetch };
  };
  const put = (key: string, value: unknown) => ({
    op: "put",
    key,
    value,
    scope: "",
  });

  it("keeps unconfirmed mutations on top of the server state", async () => {
    const { c } = setup(() => ({
      cookie: 1,
      lastMutationId: 0,
      patch: [put("k", 5), put("o", 1)],
    }));
    await c.mutate.set({ k: "k", v: 9 });
    await c.flush();
    await c.pull();
    expect(c.read((tx) => [tx.get("k"), tx.get("o")])).toEqual([9, 1]);
  });

  it("replaces a confirmed mutation with server state and never replays it", async () => {
    const { c, run } = setup(() => ({
      cookie: 1,
      lastMutationId: 1,
      patch: [put("k", 5)],
    }));
    await c.mutate.set({ k: "k", v: 9 });
    await c.flush();
    await c.pull();
    expect(c.read((tx) => tx.get("k"))).toBe(5);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rolls back a mutation the server rejected", async () => {
    const { c } = setup(() => ({ cookie: 1, lastMutationId: 1, patch: [] }));
    await c.mutate.set({ k: "k", v: 9 });
    expect(c.read((tx) => tx.get("k"))).toBe(9);
    await c.flush();
    await c.pull();
    expect(c.read((tx) => tx.get("k"))).toBeUndefined();
  });

  it("notifies only subscriptions whose data changed, and clear drops old keys", async () => {
    let n = 0;
    const { c, fetch } = setup(() =>
      ++n === 1
        ? { cookie: 1, lastMutationId: 0, patch: [put("a", 1), put("b", 1)] }
        : n === 2
          ? { cookie: 2, lastMutationId: 0, patch: [put("a", 2)] }
          : {
              cookie: 3,
              lastMutationId: 0,
              patch: [{ op: "clear" }, put("b", 1)],
            },
    );
    await c.pull();
    const a = vi.fn();
    const b = vi.fn();
    c.subscribe((tx) => tx.get("a"), a);
    c.subscribe((tx) => tx.get("b"), b);
    await c.pull();
    expect(a).toHaveBeenCalledWith(2);
    expect(b).not.toHaveBeenCalled();
    await c.pull();
    expect(a).toHaveBeenLastCalledWith(undefined);
    expect(b).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]!.body)).cookie).toBe(
      2,
    );
  });
});
