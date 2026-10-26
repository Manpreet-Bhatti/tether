import { defineMutator } from "@tether/protocol";
import { z } from "zod";

export const Issue = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  pos: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const issueKey = (id: string) => `issue/${id}`;

export const mutators = {
  createIssue: defineMutator(
    "createIssue@1",
    Issue.pick({ id: true, title: true, pos: true }),
    async (tx, a) => {
      if (await tx.has(issueKey(a.id))) throw new Error(`issue ${a.id} exists`);
      await tx.set(issueKey(a.id), { ...a, status: "todo" } satisfies Issue);
    },
  ),
  updateIssue: defineMutator(
    "updateIssue@1",
    Issue.partial().required({ id: true }),
    async (tx, a) => {
      const cur = Issue.parse(await tx.get(issueKey(a.id)));
      await tx.set(issueKey(a.id), {
        id: cur.id,
        title: a.title ?? cur.title,
        status: a.status ?? cur.status,
        pos: a.pos ?? cur.pos,
      } satisfies Issue);
    },
  ),
};
