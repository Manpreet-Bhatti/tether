import { serve } from "@hono/node-server";
import { migrate, pgStorage } from "@tether/server";
import postgres from "postgres";
import { createApp } from "./app.js";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://tether:tether@localhost:5432/tether",
);
await migrate(sql);
serve({
  fetch: createApp(pgStorage(sql)).fetch,
  port: Number(process.env.PORT ?? 8787),
});
