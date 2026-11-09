import { serve } from "@hono/node-server";
import { createClient } from "@tether/client";
import { memoryStorage } from "@tether/server";
import { mutators } from "@tether/tracker-shared";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { mint, secret } from "./auth.js";

let server: Server;
let port: number;
let srv: ReturnType<typeof createApp>;
let onChange: ReturnType<typeof vi.fn<(cb: () => void) => () => void>>;
let token: string;
let clients: ReturnType<typeof mk>[] = [];

beforeEach(async () => {
  const mem = memoryStorage();
  onChange = vi.fn<(cb: () => void) => () => void>((cb) => mem.onChange(cb));
  srv = createApp({ ...mem, onChange }, { secret, log: () => {} });
  server = serve(
    { fetch: srv.app.fetch, port: 0 },
    (i) => (port = i.port),
  ) as Server;
  srv.injectWebSocket(server);
  await new Promise((r) => server.once("listening", r));
  token = await mint("u1");
});
afterEach(async () => {
  clients.forEach((c) => c.close());
  clients = [];
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const headers = () => ({ authorization: `Bearer ${token}` });
const mk = (reconnectMs = 10) =>
  createClient({
    mutators,
    userId: "u1",
    push: {
      url: `http://localhost:${port}/push`,
      headers: headers(),
      backoffMs: 10,
    },
    pull: { url: `http://localhost:${port}/pull`, headers: headers() },
    poke: {
      url: `ws://localhost:${port}/poke?token=${token}`,
      backoffMs: reconnectMs,
    },
  });
const connect = (reconnectMs?: number) => {
  const c = mk(reconnectMs);
  clients.push(c);
  return c;
};
const sockets = async () =>
  (await (await srv.app.request("http://x/metrics")).json()).sockets;
const issues = (c: ReturnType<typeof mk>) =>
  c.read((tx) => tx.scan({ prefix: "issue/" })).length;

describe("poke", () => {
  it("delivers another client's change without the receiver pulling", async () => {
    const [a, b] = [connect(), connect()];
    await waitFor(async () => expect(await sockets()).toBe(2));
    await a.mutate.createIssue({ id: "x", title: "X", pos: "a0" });
    await waitFor(() => expect(issues(b)).toBe(1));
  });

  it("recovers on its own when the server drops every socket", async () => {
    const [a, b] = [connect(), connect(300)];
    await waitFor(async () => expect(await sockets()).toBe(2));
    srv.dropSockets();
    await a.mutate.createIssue({ id: "y", title: "Y", pos: "a0" });
    await a.flush();
    expect(issues(b)).toBe(0);
    await waitFor(() => expect(issues(b)).toBe(1));
    await waitFor(async () => expect(await sockets()).toBe(2));
    await a.mutate.createIssue({ id: "z", title: "Z", pos: "a1" });
    await waitFor(() => expect(issues(b)).toBe(2));
  });

  it("refuses a socket without a token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/poke`);
    let opened = false;
    ws.addEventListener("open", () => (opened = true));
    await once(ws, "close");
    expect(opened).toBe(false);
  });

  it("re-subscribes on every socket, so a failed LISTEN is retried", async () => {
    connect();
    connect();
    await waitFor(async () => expect(await sockets()).toBe(2));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("closes a user's oldest socket past the per-user cap", async () => {
    const open = async () => {
      const ws = new WebSocket(`ws://localhost:${port}/poke?token=${token}`);
      await once(ws, "open");
      return ws;
    };
    const first = await open();
    const closed = new Promise<number>((r) =>
      first.addEventListener("close", (e) => r((e as CloseEvent).code)),
    );
    const rest = [];
    for (let i = 0; i < 10; i++) rest.push(await open());
    expect(await closed).toBe(1008);
    await waitFor(async () => expect(await sockets()).toBe(10));
    rest.forEach((w) => w.close());
  });

  it("drops a socket that sends a frame over the size cap", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/poke?token=${token}`);
    await once(ws, "open");
    const code = new Promise<number>((r) =>
      ws.addEventListener("close", (e) => r((e as CloseEvent).code)),
    );
    ws.send("x".repeat(10_000));
    expect(await code).toBe(1009);
  });

  it("merges commits inside one window into a single poke", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/poke?token=${token}`);
    await once(ws, "open");
    let pokes = 0;
    ws.onmessage = () => pokes++;
    // Three commits at once, in-process: far inside the 50 ms window however slow the machine.
    await Promise.all(
      ["p", "q", "r"].map((id) =>
        srv.app.request("http://x/push", {
          method: "POST",
          headers: { ...headers(), "content-type": "application/json" },
          body: JSON.stringify({
            clientId: `c-${id}`,
            schemaVersion: 1,
            mutations: [
              {
                id: 1,
                name: "createIssue@1",
                args: { id, title: id, pos: id },
                timestamp: 1,
              },
            ],
          }),
        }),
      ),
    );
    await waitFor(() => expect(pokes).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 150));
    expect(pokes).toBe(1);
    ws.close();
  });
});

const waitFor = <T>(fn: () => T | Promise<T>) =>
  vi.waitFor(fn, { timeout: 3000, interval: 10 });
const once = (ws: WebSocket, type: string) =>
  new Promise<void>((r) =>
    ws.addEventListener(type, () => r(), { once: true }),
  );
