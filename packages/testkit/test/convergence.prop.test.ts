import { randomUUID } from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { it } from "vitest";
import { memoryStorage, migrate, pgStorage, type ServerStorage } from "@tether/server";
import { assertConverged, createHarness, tick, toy, type Fault, type Harness } from "../src/index.js";
import { regressions } from "./regressions.js";

const pg = !!process.env.TETHER_PG;
const numRuns = pg ? 200 : process.env.CI ? 500 : 2000;
const url = process.env.DATABASE_URL ?? "postgres://tether:tether@localhost:5432/tether";

// Memory by default; with TETHER_PG=1 each run gets its own Postgres schema.
async function withStorage(fn: (s: ServerStorage) => Promise<void>): Promise<void> {
  if (!pg) return fn(memoryStorage());
  const schema = `t_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { connection: { search_path: schema }, onnotice: () => {} });
  try {
    await admin`create schema ${admin(schema)}`;
    await migrate(sql);
    await fn(pgStorage(sql));
  } finally {
    await sql.end();
    await admin`drop schema if exists ${admin(schema)} cascade`;
    await admin.end();
  }
}

const N = 3;
const client = fc.nat(N - 1);
const key = fc.constantFrom("a", "b", "c");
const fault = fc.constantFrom<Fault>("ok", "ok", "lose-request", "lose-response", "dup");
const mutation = fc.oneof(
  fc.record({ name: fc.constant("incr" as const), args: fc.record({ k: key, by: fc.integer({ min: 1, max: 5 }) }) }),
  fc.record({ name: fc.constant("decr" as const), args: fc.record({ k: key }) }),
  fc.record({ name: fc.constant("listInsert" as const), args: fc.record({ at: fc.nat(5), v: fc.string({ maxLength: 3 }) }) }),
  fc.record({ name: fc.constant("listDelete" as const), args: fc.record({ at: fc.nat(5) }) }),
  fc.record({ name: fc.constant("lwwSet" as const), args: fc.record({ k: key, v: fc.nat(9), ts: fc.nat(5) }) }),
  fc.record({ name: fc.constant("forbidden" as const), args: fc.record({ k: key }) }),
);

// The model is empty: faults hit whichever call is queued, so legality depends on timing, not model state.
const cmd = (label: string, run: (h: Harness) => unknown): fc.AsyncCommand<object, Harness> => ({
  check: () => true,
  run: async (_m, h) => {
    await run(h);
    await tick();
    await tick();
  },
  toString: () => label,
});

const commands = [
  fc.tuple(client, mutation).map(([c, m]) =>
    cmd(`mutate(c${c}, ${m.name} ${JSON.stringify(m.args)})`, (h) => h.mutate(c, m.name, m.args)),
  ),
  client.map((c) => cmd(`pull(c${c})`, (h) => h.pull(c))),
  fc.tuple(fc.nat(), fault).map(([i, f]) => cmd(`deliver(${i}, ${f})`, (h) => h.net.deliver(i, f))),
  client.map((c) => cmd(`disconnect(c${c})`, (h) => h.disconnect(c))),
  client.map((c) => cmd(`reconnect(c${c})`, (h) => h.reconnect(c))),
];

const converges = fc.asyncProperty(fc.commands(commands, { maxCommands: 40 }), (cs) =>
  withStorage(async (storage) => {
    const h = createHarness({ clients: N, mutators: toy, storage });
    await fc.asyncModelRun(() => ({ model: {}, real: h }), cs);
    await h.settle();
    await assertConverged(h);
  }),
);

it("clients converge under dropped, duplicated, reordered and offline traffic", async () => {
  for (const r of regressions) await fc.assert(converges, r);
  await fc.assert(converges, { numRuns });
}, 600_000);
