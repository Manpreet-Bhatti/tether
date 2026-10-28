import type { Tx } from "@tether/protocol";
import { fileURLToPath } from "node:url";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import type { PushTxn, ServerStorage } from "./types.js";

export const migrate = (sql: Sql) =>
  sql.file(fileURLToPath(new URL("../../sql/001_init.sql", import.meta.url)));

const pgTx = (sql: TransactionSql, version: number): Tx => ({
  get: async (key) => {
    const [row] = await sql`select value from entries where key = ${key}`;
    return row?.value;
  },
  has: async (key) =>
    (await sql`select 1 from entries where key = ${key}`).length > 0,
  scan: async ({ prefix }) =>
    (
      await sql`select key, value from entries where starts_with(key, ${prefix}) order by key`
    ).map((r): [string, unknown] => [r.key, r.value]),
  set: async (key, value) => {
    const json = sql.json(value as JSONValue);
    const [{ scope }] = (await sql`
      insert into entries (key, value, version) values (${key}, ${json}, ${version})
      on conflict (key) do update set value = excluded.value, version = excluded.version
      returning scope`) as [{ scope: string }];
    await sql`
      insert into change_log (version, key, scope, op, value) values (${version}, ${key}, ${scope}, 'put', ${json})
      on conflict (version, key, scope) do update set op = 'put', value = excluded.value`;
  },
  del: async (key) => {
    const [row] =
      await sql`delete from entries where key = ${key} returning scope`;
    if (!row) return;
    await sql`
      insert into change_log (version, key, scope, op, value) values (${version}, ${key}, ${row.scope}, 'del', null)
      on conflict (version, key, scope) do update set op = 'del', value = null`;
  },
});

const pgTxn = (sql: TransactionSql): PushTxn => ({
  lockClient: async (clientId, userId) => {
    await sql`insert into clients (client_id, user_id) values (${clientId}, ${userId}) on conflict do nothing`;
    const [row] =
      await sql`select user_id, last_mutation_id from clients where client_id = ${clientId} for update`;
    return {
      userId: row!.user_id,
      lastMutationId: Number(row!.last_mutation_id),
    };
  },
  setLastMutationId: async (clientId, id) => {
    await sql`update clients set last_mutation_id = ${id} where client_id = ${clientId}`;
  },
  nextVersion: async () => {
    const [row] =
      await sql`update meta set version = version + 1 where id = 1 returning version`;
    return Number(row!.version);
  },
  attempt: (version, fn) =>
    sql.savepoint(async (sp) => void (await fn(pgTx(sp, version)))),
});

export const pgStorage = (sql: Sql): ServerStorage => ({
  transact: (fn) => sql.begin(async (t) => fn(pgTxn(t))) as Promise<never>,
});
