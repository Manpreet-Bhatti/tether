import { createClient } from "@tether/client";
import { expect, it } from "vitest";
import { mutators } from "../src/index.js";

it("create, update, and a missing-issue update", async () => {
  const c = createClient({ mutators, userId: "u" });
  await c.mutate.createIssue({ id: "a", title: "t", pos: "a0" });
  await c.mutate.updateIssue({ id: "a", status: "done" });
  expect(c.read((tx) => tx.get("issue/a"))).toEqual({
    id: "a",
    title: "t",
    status: "done",
    pos: "a0",
  });
  await expect(
    c.mutate.updateIssue({ id: "nope", title: "x" }),
  ).rejects.toThrow();
  await expect(
    c.mutate.createIssue({ id: "a", title: "dup", pos: "a1" }),
  ).rejects.toThrow("exists");
});
