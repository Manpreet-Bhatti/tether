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
