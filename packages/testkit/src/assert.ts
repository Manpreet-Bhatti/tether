import { deepStrictEqual } from "node:assert";
import type { Harness } from "./harness.js";

// Call after `settle()`. Throws on the first broken invariant.
export async function assertConverged(h: Harness): Promise<void> {
  deepStrictEqual(h.problems, []);

  const server = (await h.storage.read((t) => t.snapshot())).flatMap((p) =>
    p.op === "put" ? [[p.key, p.value] as const] : [],
  );
  h.clients.forEach((c, i) =>
    deepStrictEqual(
      c.read((tx) => tx.scan({ prefix: "" })),
      server,
      `client c${i} differs from the server`,
    ),
  );

  // Exactly once: the server ran every issued mutation once, and nothing else.
  const byUid = (a: [string, number], b: [string, number]) => (a[0] < b[0] ? -1 : 1);
  deepStrictEqual(
    [...h.applied].sort(byUid),
    [...h.issued].map((uid): [string, number] => [uid, 1]).sort(byUid),
  );
}
