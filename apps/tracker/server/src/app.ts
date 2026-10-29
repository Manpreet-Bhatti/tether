import {
  createPushHandler,
  PushError,
  type ServerStorage,
} from "@tether/server";
import { mutators } from "@tether/tracker-shared";
import { Hono } from "hono";

export function createApp(storage: ServerStorage) {
  const push = createPushHandler(storage, Object.values(mutators));
  const app = new Hono();

  app.post("/push", async (c) => {
    const userId = c.req.header("x-user-id");
    if (!userId) return c.json({ error: "missing x-user-id" }, 401);
    const body = await c.req.json().catch(() => undefined);
    try {
      return c.json(await push(userId, body));
    } catch (e) {
      if (e instanceof PushError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  return app;
}
