import { createClient } from "@tether/client";
import { migrate, pgStorage } from "@tether/server";
import { mutators } from "@tether/tracker-shared";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../src/app.js";

const url =
  process.env.DATABASE_URL ?? "postgres://tether:tether@localhost:5432/tether";
const schema = `t_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(url, { onnotice: () => {} });
const sql = postgres(url, { connection: { search_path: schema } });
const app = createApp(pgStorage(sql));

beforeAll(async () => {
  await admin`create schema ${admin(schema)}`;
  await migrate(sql);
});
afterAll(async () => {
  await sql.end();
  await admin`drop schema ${admin(schema)} cascade`;
  await admin.end();
});

const pushOpts = (
  fetch: typeof globalThis.fetch,
  headers: Record<string, string> = { "x-user-id": "u1" },
) => ({ url: "http://x/push", headers, fetch, backoffMs: 1 });

describe("tracker push", () => {
  it("applies each mutation once when the response is lost and the server flakes", async () => {
    let calls = 0;
    const flaky = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        if (calls === 1) throw new TypeError("network down");
        if (calls === 2) {
          await app.request(input, init);
          throw new TypeError("connection reset");
        }
        if (calls === 3) return new Response("busy", { status: 503 });
        return app.request(input, init);
      },
    );
    const c = createClient({ mutators, userId: "u1", push: pushOpts(flaky) });
    await c.mutate.createIssue({ id: "a", title: "A", pos: "a0" });
    await c.mutate.updateIssue({ id: "a", status: "doing" });
    await c.flush();

    expect(flaky.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(
      (await sql`select value from entries where key = 'issue/a'`)[0]?.value,
    ).toEqual({
      id: "a",
      title: "A",
      status: "doing",
      pos: "a0",
    });
    expect(await sql`select last_mutation_id from clients`).toMatchObject([
      { last_mutation_id: "2" },
    ]);
  });

  it("stops and reports on a non-retryable response", async () => {
    const onError = vi.fn();
    const c = createClient({
      mutators,
      userId: "u1",
      push: { ...pushOpts((i, init) => app.request(i, init), {}), onError },
    });
    await c.mutate.createIssue({ id: "b", title: "B", pos: "a1" });
    await c.flush();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("401") }),
    );
  });

  it("rejects a forged client id with 403", async () => {
    const send = (userId: string) =>
      app.request("http://x/push", {
        method: "POST",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "forged",
          schemaVersion: 1,
          mutations: [],
        }),
      });
    expect((await send("u1")).status).toBe(200);
    expect((await send("u2")).status).toBe(403);
  });

  it("returns 400 on a non-JSON body", async () => {
    const res = await app.request("http://x/push", {
      method: "POST",
      headers: { "x-user-id": "u1" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });
});

describe("tracker pull", () => {
  beforeEach(async () => {
    await sql`truncate entries, change_log, clients`;
    await sql`update meta set version = 0`;
  });

  const via = (userId = "u1") => ({
    headers: { "x-user-id": userId },
    fetch: ((i, init) => app.request(i, init)) as typeof globalThis.fetch,
  });
  const client = () =>
    createClient({
      mutators,
      userId: "u1",
      push: { url: "http://x/push", backoffMs: 1, ...via() },
      pull: { url: "http://x/pull", ...via() },
    });
  const titles = (c: ReturnType<typeof client>) =>
    c.read((tx) => tx.scan({ prefix: "issue/" }));

  it("converges two clients editing the same issue", async () => {
    const a = client();
    const b = client();
    await a.mutate.createIssue({ id: "x", title: "X", pos: "a0" });
    await a.flush();
    await Promise.all([a.pull(), b.pull()]);
    expect(titles(b)).toHaveLength(1);

    await a.mutate.updateIssue({ id: "x", title: "from a", status: "doing" });
    await b.mutate.updateIssue({ id: "x", title: "from b", pos: "a1" });
    await a.flush();
    await b.flush();
    await Promise.all([a.pull(), b.pull()]);
    const expected = [
      ["issue/x", { id: "x", title: "from b", status: "doing", pos: "a1" }],
    ];
    expect(titles(a)).toEqual(expected);
    expect(titles(b)).toEqual(expected);
    expect(
      (await sql`select value from entries where key = 'issue/x'`)[0]?.value,
    ).toEqual(expected[0]![1]);
  });

  it("gives a late-joining client the full state", async () => {
    const a = client();
    await a.mutate.createIssue({ id: "y", title: "Y", pos: "a2" });
    await a.flush();
    const late = client();
    await late.pull();
    expect(titles(late)).toEqual(titles(a));
  });

  it("answers pull with 401 without a user and 400 on junk", async () => {
    const post = (headers: Record<string, string>) =>
      app.request("http://x/pull", { method: "POST", headers, body: "{" });
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-user-id": "u1" })).status).toBe(400);
  });
});
