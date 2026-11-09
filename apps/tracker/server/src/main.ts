import { serve } from "@hono/node-server";
import { migrate, pgStorage } from "@tether/server";
import postgres from "postgres";
import { createApp } from "./app.js";

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error("JWT_SECRET is required");
const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://tether:tether@localhost:5432/tether",
);
await migrate(sql);
const { app, injectWebSocket } = createApp(pgStorage(sql), { secret });
const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 8787),
});
injectWebSocket(server);
