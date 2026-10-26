import type { z } from "zod";

export interface Tx {
  get(key: string): Promise<unknown>;
  has(key: string): Promise<boolean>;
  scan(opts: { prefix: string }): Promise<[string, unknown][]>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export interface MutatorCtx {
  userId: string;
  location: "client" | "server";
}

export interface Mutator<A = unknown> {
  name: string; // versioned, e.g. "createIssue@1"
  schema: z.ZodType<A>;
  fn: (tx: Tx, args: A, ctx: MutatorCtx) => Promise<void>;
}

export const defineMutator = <S extends z.ZodType>(
  name: string,
  schema: S,
  fn: (tx: Tx, args: z.output<S>, ctx: MutatorCtx) => Promise<void>,
): Mutator<z.output<S>> => ({ name, schema: schema as z.ZodType<z.output<S>>, fn });

// Looks up by wire name and Zod-parses args before running. Client and server share this.
export function createRegistry(mutators: Mutator<any>[]) {
  const byName = new Map(mutators.map((m) => [m.name, m]));
  return async (tx: Tx, name: string, args: unknown, ctx: MutatorCtx): Promise<void> => {
    const m = byName.get(name);
    if (!m) throw new Error(`unknown mutator: ${name}`);
    await m.fn(tx, m.schema.parse(args), ctx);
  };
}
