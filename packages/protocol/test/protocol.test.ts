import { describe, expect, it } from "vitest";
import { PatchOp, PullRequest, PullResponse, PushRequest } from "../src/index.js";

describe("protocol schemas", () => {
  it("round-trips a push", () => {
    const push = {
      clientId: "c1",
      schemaVersion: 1,
      mutations: [{ id: 1, name: "createIssue@1", args: { id: "a", tags: [1, null] }, timestamp: 5 }],
    };
    expect(PushRequest.parse(JSON.parse(JSON.stringify(push)))).toEqual(push);
  });

  it("round-trips a pull", () => {
    const req = { clientId: "c1", cookie: null, scopes: ["p/1"] };
    expect(PullRequest.parse(req)).toEqual(req);
    const res = {
      cookie: 3,
      lastMutationId: 2,
      patch: [{ op: "clear" }, { op: "put", key: "issue/a", value: { t: "x" }, scope: "p/1" }, { op: "del", key: "issue/b" }],
    };
    expect(PullResponse.parse(JSON.parse(JSON.stringify(res)))).toEqual(res);
  });

  it("rejects malformed input", () => {
    expect(PushRequest.safeParse({ clientId: "", schemaVersion: 1, mutations: [] }).success).toBe(false);
    expect(PushRequest.safeParse({ clientId: "c", schemaVersion: 1, mutations: [{ id: 0, name: "x", args: 1, timestamp: 1 }] }).success).toBe(false);
    expect(PatchOp.safeParse({ op: "nope" }).success).toBe(false);
  });
});
