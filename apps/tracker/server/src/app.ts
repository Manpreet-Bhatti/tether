import { createNodeWebSocket } from "@hono/node-ws";
import {
  createPullHandler,
  createPushHandler,
  PullError,
  PushError,
  type ServerStorage,
} from "@tether/server";
import { mutators } from "@tether/tracker-shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { verify } from "hono/jwt";
import type { WSContext } from "hono/ws";

export interface AppOpts {
  secret: string;
  maxBodyBytes?: number;
  schemaVersions?: readonly number[];
  rate?: { burst: number; perSec: number };
  log?: (line: object) => void;
}

const POKE_MERGE_MS = 50;
const MAX_SOCKETS_PER_USER = 10;
const stat = () => ({ requests: 0, totalMs: 0, maxMs: 0, bytes: 0 });

export function createApp(storage: ServerStorage, opts: AppOpts) {
  const {
    secret,
    maxBodyBytes = 1_000_000,
    rate = { burst: 100, perSec: 50 },
    log = (line) => console.log(JSON.stringify(line)),
  } = opts;
  if (secret.length < 32) throw new Error("secret must be at least 32 chars");

  const metrics = {
    push: stat(),
    pull: stat(),
    mutationsOk: 0,
    mutationsRejected: 0,
    rateLimited: 0,
    pokesSent: 0,
  };
  const push = createPushHandler(
    storage,
    Object.values(mutators),
    (e) => {
      metrics[e.error === undefined ? "mutationsOk" : "mutationsRejected"]++;
      log({ ev: "mutation", at: new Date().toISOString(), ...e });
    },
    { schemaVersions: opts.schemaVersions },
  );
  const pull = createPullHandler(storage);

  const app = new Hono<{ Variables: { userId: string } }>();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({
    app,
  });

  wss.options.maxPayload = 1024;
  app.use(compress());

  type TokenOf = (c: Context) => string | undefined;
  const fromHeader: TokenOf = (c) =>
    c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const fromQuery: TokenOf = (c) => c.req.query("token");
  const auth =
    (tokenOf: TokenOf): MiddlewareHandler =>
    async (c, next) => {
      const token = tokenOf(c);
      const claims =
        token && (await verify(token, secret, "HS256").catch(() => null));

      if (
        !claims ||
        typeof claims.sub !== "string" ||
        typeof claims.exp !== "number"
      )
        return c.json({ error: "unauthorized" }, 401);
      c.set("userId", claims.sub);
      await next();
    };

  const buckets = new Map<string, { tokens: number; at: number }>();
  const limit: MiddlewareHandler = async (c, next) => {
    const id = c.get("userId");
    const now = Date.now();
    const b = buckets.get(id) ?? { tokens: rate.burst, at: now };
    b.tokens = Math.min(
      rate.burst,
      b.tokens + ((now - b.at) / 1000) * rate.perSec,
    );
    b.at = now;
    buckets.set(id, b);
    if (b.tokens < 1) {
      metrics.rateLimited++;
      c.header("retry-after", String(Math.ceil((1 - b.tokens) / rate.perSec)));
      return c.json({ error: "rate limited" }, 429);
    }
    b.tokens--;
    await next();
  };

  const guards = [
    auth(fromHeader),
    limit,
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) => c.json({ error: "body too large" }, 413),
    }),
  ] as const;
  const handler =
    (
      name: "push" | "pull",
      handle: (userId: string, body: unknown) => Promise<object>,
    ) =>
    async (c: Context<{ Variables: { userId: string } }>) => {
      const t0 = performance.now();
      const body = await c.req.json().catch(() => undefined);
      try {
        const out = JSON.stringify(await handle(c.get("userId"), body));
        metrics[name].bytes += Buffer.byteLength(out);
        return c.body(out, 200, { "content-type": "application/json" });
      } catch (e) {
        if (e instanceof PushError || e instanceof PullError)
          return c.json({ error: e.message }, e.status);
        throw e;
      } finally {
        const ms = performance.now() - t0;
        const s = metrics[name];
        s.requests++;
        s.totalMs += ms;
        s.maxMs = Math.max(s.maxMs, ms);
      }
    };
  app.post("/push", ...guards, handler("push", push));
  app.post("/pull", ...guards, handler("pull", pull));

  const sockets = new Map<WSContext, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One poke per socket per window, however many commits landed in it.
  const poke = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      for (const ws of sockets.keys()) {
        if (ws.readyState !== 1) continue;
        ws.send("{}");
        metrics.pokesSent++;
      }
    }, POKE_MERGE_MS);
  };
  app.get(
    "/poke",
    auth(fromQuery),
    upgradeWebSocket((c) => {
      const userId = c.get("userId");
      return {
        onOpen: (_, ws) => {
          let n = 0;
          let oldest: WSContext | undefined;
          for (const [s, u] of sockets) if (u === userId) (oldest ??= s), n++;
          if (n >= MAX_SOCKETS_PER_USER)
            oldest!.close(1008, "too many sockets");
          sockets.set(ws, userId);

          storage.onChange(poke);
        },
        onClose: (_, ws) => void sockets.delete(ws),
      };
    }),
  );

  app.get("/metrics", (c) => c.json({ ...metrics, sockets: sockets.size }));

  return {
    app,
    injectWebSocket,
    dropSockets: () => sockets.forEach((_, ws) => ws.close(1012, "restart")),
  };
}
