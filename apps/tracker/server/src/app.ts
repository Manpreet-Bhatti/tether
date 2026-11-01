import {
  createPullHandler,
  createPushHandler,
  PullError,
  PushError,
  type ServerStorage,
} from "@tether/server";
import { mutators } from "@tether/tracker-shared";
import { Hono, type Context } from "hono";
import { compress } from "hono/compress";

export function createApp(storage: ServerStorage) {
  const push = createPushHandler(storage, Object.values(mutators));
  const pull = createPullHandler(storage);
  const app = new Hono();
  app.use(compress());

  const route =
    (handle: (userId: string, body: unknown) => Promise<object>) =>
    async (c: Context) => {
      const userId = c.req.header("x-user-id");
      if (!userId) return c.json({ error: "missing x-user-id" }, 401);
      const body = await c.req.json().catch(() => undefined);
      try {
        return c.json(await handle(userId, body));
      } catch (e) {
        if (e instanceof PushError || e instanceof PullError)
          return c.json({ error: e.message }, e.status);
        throw e;
      }
    };
  app.post("/push", route(push));
  app.post("/pull", route(pull));

  return app;
}
