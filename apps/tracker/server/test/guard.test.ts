import { memoryStorage } from "@tether/server";
import { sign } from "hono/jwt";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppOpts } from "../src/app.js";
import { secret } from "./auth.js";

const now = () => Math.floor(Date.now() / 1000);
const mint = (claims: Record<string, unknown>, key = secret) =>
  sign(claims, key, "HS256");
const post = async (
  app: ReturnType<typeof createApp>["app"],
  path: string,
  token: string | undefined,
  body: unknown = { clientId: "c", schemaVersion: 1, mutations: [] },
) =>
  app.request(`http://x${path}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
const make = (o: Partial<AppOpts> = {}) =>
  createApp(memoryStorage(), { secret, log: () => {}, ...o });

describe("auth", () => {
  it("rejects missing, forged, expired and non-expiring tokens on push and pull", async () => {
    const { app } = make();
    const bad = [
      undefined,
      "junk",
      await mint({ sub: "u1", exp: now() + 60 }, "x".repeat(32)),
      await mint({ sub: "u1", exp: now() - 60 }),
      await mint({ sub: "u1" }),
      await mint({ exp: now() + 60 }),
      // alg "none": a classic bypass
      `${btoa('{"alg":"none","typ":"JWT"}')}.${btoa(`{"sub":"u1","exp":${now() + 60}}`)}.`,
    ];
    for (const path of ["/push", "/pull"])
      for (const t of bad)
        expect((await post(app, path, t)).status, `${path} ${t}`).toBe(401);
    const ok = await mint({ sub: "u1", exp: now() + 60 });
    expect((await post(app, "/push", ok)).status).toBe(200);
  });

  it("refuses the poke handshake without a valid token", async () => {
    const { app } = make();
    const res = await app.request("http://x/poke?token=junk", {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("refuses a short secret", () => {
    expect(() => make({ secret: "short" })).toThrow();
  });
});

describe("limits", () => {
  it("answers 413 over the body cap, before parsing", async () => {
    const { app } = make({ maxBodyBytes: 100 });
    const t = await mint({ sub: "u1", exp: now() + 60 });
    const big = { clientId: "c".repeat(500), schemaVersion: 1, mutations: [] };
    expect((await post(app, "/push", t, big)).status).toBe(413);
  });

  it("rate-limits per user with 429 and retry-after", async () => {
    const { app } = make({ rate: { burst: 2, perSec: 0.01 } });
    const a = await mint({ sub: "a", exp: now() + 60 });
    const b = await mint({ sub: "b", exp: now() + 60 });
    expect((await post(app, "/pull", a, {})).status).toBe(400); // passes the limiter, fails validation
    expect((await post(app, "/pull", a, {})).status).toBe(400);
    const limited = await post(app, "/pull", a, {});
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(app, "/pull", b, {})).status).toBe(400);
  });
});

describe("observability", () => {
  it("logs each mutation once and counts them, retries excluded", async () => {
    const log = vi.fn();
    const { app } = make({ log });
    const t = await mint({ sub: "u1", exp: now() + 60 });
    const body = {
      clientId: "c1",
      schemaVersion: 1,
      mutations: [
        {
          id: 1,
          name: "createIssue@1",
          args: { id: "a", title: "A", pos: "a0" },
          timestamp: 1,
        },
        { id: 2, name: "updateIssue@1", args: { id: "nope" }, timestamp: 2 },
      ],
    };
    await post(app, "/push", t, body);
    await post(app, "/push", t, body);
    await post(app, "/pull", t, { clientId: "c1", cookie: null, scopes: [] });

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toMatchObject({
      ev: "mutation",
      userId: "u1",
      id: 1,
      name: "createIssue@1",
    });
    expect(log.mock.calls[1]![0]).toMatchObject({
      id: 2,
      error: expect.any(String),
    });
    const m = await (await app.request("http://x/metrics")).json();
    expect(m).toMatchObject({ mutationsOk: 1, mutationsRejected: 1 });
    expect(m.push.requests).toBe(2);
    expect(m.pull.bytes).toBeGreaterThan(0);
  });
});
