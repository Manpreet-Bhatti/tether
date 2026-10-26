import { useMutate, useQuery } from "@tether/react";
import { Issue, type mutators } from "@tether/tracker-shared";
import { generateKeyBetween } from "fractional-indexing";
import { useState } from "react";

const STATUSES = Issue.shape.status.options;

export function App() {
  const mutate = useMutate<typeof mutators>();
  const issues = useQuery((tx) =>
    tx
      .scan({ prefix: "issue/" })
      .map(([, v]) => v as Issue)
      .sort((a, b) => (a.pos < b.pos ? -1 : 1)),
  );
  const [title, setTitle] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);

  const add = () => {
    if (!title.trim()) return;
    const pos = generateKeyBetween(issues.at(-1)?.pos ?? null, null);
    void mutate.createIssue({
      id: crypto.randomUUID(),
      title: title.trim(),
      pos,
    });
    setTitle("");
  };

  // Dragging down lands after the target, dragging up lands before it.
  const drop = (targetId: string) => {
    const from = issues.findIndex((i) => i.id === dragId);
    const to = issues.findIndex((i) => i.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const rest = issues.filter((i) => i.id !== dragId);
    const t = rest.findIndex((i) => i.id === targetId);
    const [lo, hi] =
      from > to ? [rest[t - 1], rest[t]] : [rest[t], rest[t + 1]];
    void mutate.updateIssue({
      id: dragId!,
      pos: generateKeyBetween(lo?.pos ?? null, hi?.pos ?? null),
    });
  };

  return (
    <main
      style={{ maxWidth: 560, margin: "2rem auto", fontFamily: "system-ui" }}
    >
      <h1>Issues</h1>
      <form onSubmit={(e) => (e.preventDefault(), add())}>
        <input
          aria-label="New issue"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button>Add</button>
      </form>
      <ul style={{ padding: 0, listStyle: "none" }}>
        {issues.map((i) => (
          <li
            key={i.id}
            data-testid="issue"
            draggable
            onDragStart={() => setDragId(i.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(i.id)}
            style={{
              display: "flex",
              gap: 8,
              padding: 4,
              border: "1px solid #ddd",
              marginTop: 4,
            }}
          >
            <input
              aria-label="Title"
              key={i.title}
              defaultValue={i.title}
              onBlur={(e) =>
                e.target.value !== i.title &&
                void mutate.updateIssue({ id: i.id, title: e.target.value })
              }
              style={{ flex: 1 }}
            />
            <select
              aria-label="Status"
              value={i.status}
              onChange={(e) =>
                void mutate.updateIssue({
                  id: i.id,
                  status: e.target.value as Issue["status"],
                })
              }
            >
              {STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </main>
  );
}
