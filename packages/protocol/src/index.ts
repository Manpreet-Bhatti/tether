import { z } from "zod";

export const Json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(Json), z.record(z.string(), Json)]),
);

export const Mutation = z.object({
  id: z.number().int().positive(), // per-client, strictly increasing from 1
  name: z.string().min(1), // versioned, e.g. "createIssue@1"
  args: Json,
  timestamp: z.number().int(),
});

export const PushRequest = z.object({
  clientId: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  mutations: z.array(Mutation).max(100),
});

export const PushResponse = z.object({
  results: z.array(z.object({ id: z.number().int().positive(), error: z.string().optional() })),
  resetRequired: z.boolean().optional(),
});

export const PullRequest = z.object({
  clientId: z.string().min(1),
  cookie: z.number().int().nonnegative().nullable(), // null = first sync
  scopes: z.array(z.string()),
});

export const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("put"), key: z.string(), value: Json, scope: z.string() }),
  z.object({ op: z.literal("del"), key: z.string() }),
  z.object({ op: z.literal("clear") }),
]);

export const PullResponse = z.object({
  cookie: z.number().int().nonnegative(),
  lastMutationId: z.number().int().nonnegative(),
  patch: z.array(PatchOp),
  resetRequired: z.boolean().optional(),
});

// Content-free: carries no data, only "pull now".
export const Poke = z.object({});

export type Mutation = z.infer<typeof Mutation>;
export type PushRequest = z.infer<typeof PushRequest>;
export type PushResponse = z.infer<typeof PushResponse>;
export type PullRequest = z.infer<typeof PullRequest>;
export type PatchOp = z.infer<typeof PatchOp>;
export type PullResponse = z.infer<typeof PullResponse>;
export * from "./mutators.js";
