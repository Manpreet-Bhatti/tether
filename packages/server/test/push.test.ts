import { defineMutator, type Mutation } from "@tether/protocol";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPushHandler,
  migrate,
  pgStorage,
  PushError,
} from "../src/index.js";

const url =
  process.env.DATABASE_URL ?? "postgres://tether:tether@localhost:5432/tether";
const schema = `t_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { onnotice: () => {} });
const sql = postgres(url, { connection: { search_path: schema } });

const inc = defineMutator("inc@1", z.object({}), async (tx) => {
  await tx.set("n", (((await tx.get("n")) as number | undefined) ?? 0) + 1);
});
const boom = defineMutator("boom@1", z.object({}), async (tx) => {
  await tx.set("half", 1);
  throw new Error("boom");
});
const push = createPushHandler(pgStorage(sql), [inc, boom]);

let t = 0;
const m = (id: number, name = "inc@1", args: unknown = {}): Mutation => ({
  id,
  name,
  args,
  timestamp: ++t,
});
const req = (clientId: string, mutations: Mutation[]) => ({
  clientId,
  schemaVersion: 1,
  mutations,
});
const entry = async (key: string) =>
  (await sql`select value from entries where key = ${key}`)[0]?.value;
const lastId = async (c: string) =>
  Number(
    (await sql`select last_mutation_id from clients where client_id = ${c}`)[0]
      ?.last_mutation_id,
  );

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
  await sql`update meta set version = 0`;
});

describe("handlePush", () => {
  it("applies a retried push once", async () => {
    const body = req("c1", [m(1), m(2)]);
    const first = await push("u1", body);
    const second = await push("u1", body);
    expect(first).toEqual({ results: [{ id: 1 }, { id: 2 }] });
    expect(second).toEqual(first);
    expect(await entry("n")).toBe(2);
    expect(await lastId("c1")).toBe(2);
    // two mutations, one push: a single version, last write wins in the log
    expect(await sql`select version, op, value from change_log`).toMatchObject([
      { op: "put", value: 2 },
    ]);
  });

  it("applies the overlap of a partially retried batch", async () => {
    await push("u1", req("c1", [m(1)]));
    await push("u1", req("c1", [m(1), m(2)]));
    expect(await entry("n")).toBe(2);
  });

  it("serializes 20 concurrent clients on one key", async () => {
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        for (let id = 1; id <= 5; id++) await push("u1", req(`c${i}`, [m(id)]));
      }),
    );
    expect(await entry("n")).toBe(100);
    const [{ version }] = await sql`select version from meta`;
    expect(Number(version)).toBe(100);
  });

  it("a failing mutation mid-batch does not block the others", async () => {
    const res = await push("u1", req("c1", [m(1), m(2, "boom@1"), m(3)]));
    expect(res.results).toEqual([
      { id: 1 },
      { id: 2, error: "boom" },
      { id: 3 },
    ]);
    expect(await entry("n")).toBe(2);
    expect(await entry("half")).toBeUndefined();
    expect(await lastId("c1")).toBe(3);
  });

  it("rejects unknown mutators and bad args per mutation", async () => {
    const res = await push(
      "u1",
      req("c1", [
        m(1, "nope@1"),
        m(2, "inc@1", { extra: 1, n: "x" }),
        m(3, "inc@1", "str"),
      ]),
    );
    expect(res.results[0]).toEqual({ id: 1, error: "unknown mutator: nope@1" });
    expect(res.results[1]?.error).toBeUndefined(); // zod strips unknown keys
    expect(res.results[2]?.error).toBeTruthy();
    expect(await lastId("c1")).toBe(3);
  });

  it("rejects a client id owned by another user", async () => {
    await push("u1", req("c1", [m(1)]));
    await expect(push("u2", req("c1", [m(2)]))).rejects.toMatchObject({
      status: 403,
    });
    expect(await entry("n")).toBe(1);
    expect(await lastId("c1")).toBe(1);
  });

  it("rejects a gap and applies nothing from that push", async () => {
    await expect(push("u1", req("c1", [m(1), m(3)]))).rejects.toMatchObject({
      status: 409,
    });
    expect(await entry("n")).toBeUndefined();
    expect(await sql`select 1 from clients`).toHaveLength(0);
  });

  it("rejects malformed and oversized requests", async () => {
    for (const body of [
      null,
      {},
      req("", []),
      req("c1", [m(0)]),
      req(
        "c1",
        Array.from({ length: 101 }, (_, i) => m(i + 1)),
      ),
    ])
      await expect(push("u1", body)).rejects.toBeInstanceOf(PushError);
  });
});
