import { defineMutator, type Mutation } from "@tether/protocol";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPullHandler,
  createPushHandler,
  migrate,
  pgStorage,
  PullError,
} from "../src/index.js";

const url =
  process.env.DATABASE_URL ?? "postgres://tether:tether@localhost:5432/tether";
const schema = `t_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { onnotice: () => {} });
const sql = postgres(url, { connection: { search_path: schema } });

const set = defineMutator(
  "set@1",
  z.object({ k: z.string(), v: z.number() }),
  (tx, a) => tx.set(a.k, a.v),
);
const del = defineMutator("del@1", z.object({ k: z.string() }), (tx, a) =>
  tx.del(a.k),
);
const storage = pgStorage(sql);
const push = createPushHandler(storage, [set, del]);
const pull = createPullHandler(storage);

let t = 0;
const send = (clientId: string, ...ms: [number, string, object][]) =>
  push("u1", {
    clientId,
    schemaVersion: 1,
    mutations: ms.map(
      ([id, name, args]): Mutation => ({ id, name, args, timestamp: ++t }),
    ),
  });
const put = (key: string, value: number) => ({
  op: "put",
  key,
  value,
  scope: "",
});

beforeAll(async () => {
  await admin`create schema ${admin(schema)}`;
  await migrate(sql);
});
afterAll(async () => {
  await sql.end();
  await admin`drop schema ${admin(schema)} cascade`;
  await admin.end();
});
beforeEach(async () => {
  await sql`truncate entries, change_log, clients`;
  await sql`update meta set version = 0, min_retained_version = 0`;
});

describe("handlePull", () => {
  it("sends a full snapshot on first sync, with the client's lastMutationId", async () => {
    await send(
      "c1",
      [1, "set@1", { k: "b", v: 2 }],
      [2, "set@1", { k: "a", v: 1 }],
    );
    expect(
      await pull("u1", { clientId: "c1", cookie: null, scopes: [] }),
    ).toEqual({
      cookie: 1,
      lastMutationId: 2,
      patch: [{ op: "clear" }, put("a", 1), put("b", 2)],
    });
    expect(
      (await pull("u1", { clientId: "new", cookie: null, scopes: [] }))
        .lastMutationId,
    ).toBe(0);
  });

  it("sends only the latest op per key since the cookie", async () => {
    await send("c1", [1, "set@1", { k: "a", v: 1 }]);
    await send(
      "c1",
      [2, "set@1", { k: "a", v: 2 }],
      [3, "set@1", { k: "b", v: 1 }],
    );
    await send("c1", [4, "del@1", { k: "b" }], [5, "set@1", { k: "c", v: 1 }]);
    const r = await pull("u1", { clientId: "c1", cookie: 1, scopes: [] });
    expect(r.cookie).toBe(3);
    expect(r.patch).toHaveLength(3);
    expect(r.patch).toEqual(
      expect.arrayContaining([
        put("a", 2),
        { op: "del", key: "b" },
        put("c", 1),
      ]),
    );
  });

  it("returns an empty patch when nothing changed", async () => {
    await send("c1", [1, "set@1", { k: "a", v: 1 }]);
    expect(await pull("u1", { clientId: "c1", cookie: 1, scopes: [] })).toEqual(
      {
        cookie: 1,
        lastMutationId: 1,
        patch: [],
      },
    );
  });

  it("resyncs fully when the cookie is older than the compacted log", async () => {
    await send("c1", [1, "set@1", { k: "a", v: 1 }]);
    await send("c1", [2, "set@1", { k: "a", v: 2 }]);
    await send("c1", [3, "set@1", { k: "b", v: 1 }]);
    await storage.compactLog(1); // keeps version 3 only
    expect((await sql`select count(*)::int as n from change_log`)[0]!.n).toBe(
      1,
    );
    const stale = await pull("u1", { clientId: "c1", cookie: 1, scopes: [] });
    expect(stale.patch).toEqual([{ op: "clear" }, put("a", 2), put("b", 1)]);
    const fresh = await pull("u1", { clientId: "c1", cookie: 2, scopes: [] });
    expect(fresh.patch).toEqual([put("b", 1)]);
  });

  it("resyncs fully when the cookie is ahead of the server", async () => {
    await send("c1", [1, "set@1", { k: "a", v: 1 }]);
    const r = await pull("u1", { clientId: "c1", cookie: 99, scopes: [] });
    expect(r.patch).toEqual([{ op: "clear" }, put("a", 1)]);
    expect(r.cookie).toBe(1);
  });

  it("rejects another user's client id and malformed requests", async () => {
    await send("c1", [1, "set@1", { k: "a", v: 1 }]);
    await expect(
      pull("u2", { clientId: "c1", cookie: null, scopes: [] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(pull("u1", { cookie: null })).rejects.toBeInstanceOf(
      PullError,
    );
  });
});
