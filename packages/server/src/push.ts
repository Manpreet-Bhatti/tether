import {
  createRegistry,
  PushRequest,
  type Mutator,
  type PushResponse,
} from "@tether/protocol";
import type { ServerStorage } from "./storage/types.js";

export class PushError extends Error {
  constructor(
    public status: 400 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function createPushHandler(
  storage: ServerStorage,
  mutators: Mutator<any>[],
) {
  const run = createRegistry(mutators);

  return async (userId: string, body: unknown): Promise<PushResponse> => {
    const parsed = PushRequest.safeParse(body);
    if (!parsed.success) throw new PushError(400, "invalid push request");
    const { clientId, mutations } = parsed.data;
    const ctx = { userId, location: "server" as const };

    return storage.transact(async (t) => {
      const client = await t.lockClient(clientId, userId);
      if (client.userId !== userId)
        throw new PushError(403, "client belongs to another user");

      let last = client.lastMutationId;
      const results: PushResponse["results"] = [];
      let version: number | undefined;

      for (const m of mutations) {
        if (m.id <= last) {
          results.push({ id: m.id });
          continue;
        }
        if (m.id > last + 1)
          throw new PushError(
            409,
            `mutation gap: expected ${last + 1}, got ${m.id}`,
          );

        version ??= await t.nextVersion();
        let error: string | undefined;
        try {
          await t.attempt(version, (tx) => run(tx, m.name, m.args, ctx));
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        // A rejected mutation still consumes its id, so the client's queue moves on.
        last = m.id;
        results.push(error === undefined ? { id: m.id } : { id: m.id, error });
      }

      if (last !== client.lastMutationId)
        await t.setLastMutationId(clientId, last);
      return { results };
    });
  };
}
