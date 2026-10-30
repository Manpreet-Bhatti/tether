import { PullRequest, type PullResponse } from "@tether/protocol";
import type { ServerStorage } from "./storage/types.js";

export class PullError extends Error {
  constructor(
    public status: 400 | 403,
    message: string,
  ) {
    super(message);
  }
}

export function createPullHandler(storage: ServerStorage) {
  return async (userId: string, body: unknown): Promise<PullResponse> => {
    const parsed = PullRequest.safeParse(body);
    if (!parsed.success) throw new PullError(400, "invalid pull request");
    const { clientId, cookie } = parsed.data;

    return storage.read(async (t) => {
      const head = await t.head(clientId);
      if (head.userId !== undefined && head.userId !== userId)
        throw new PullError(403, "client belongs to another user");

      // A cookie newer than the server means the client talked to a different database.
      const stale =
        cookie === null ||
        cookie < head.minRetainedVersion ||
        cookie > head.version;
      const patch = stale
        ? [{ op: "clear" as const }, ...(await t.snapshot())]
        : cookie === head.version
          ? []
          : await t.changesSince(cookie);
      return {
        cookie: head.version,
        lastMutationId: head.lastMutationId,
        patch,
      };
    });
  };
}
