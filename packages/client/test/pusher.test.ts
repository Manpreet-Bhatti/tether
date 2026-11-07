import { describe, expect, it } from "vitest";
import { Pusher } from "../src/pusher.js";

const ok = () =>
  new Response(JSON.stringify({ results: [] }), {
    headers: { "content-type": "application/json" },
  });

describe("Pusher", () => {
  it("splits a large backlog into bodies under the server's 1 MB cap", async () => {
    let up = false;
    const sizes: number[] = [];
    const ids: number[] = [];
    const p = new Pusher("c1", {
      url: "http://x/push",
      backoffMs: 1,
      fetch: async (_, init) => {
        if (!up) throw new TypeError("server down");
        const body = String(init!.body);
        sizes.push(body.length);
        ids.push(
          ...JSON.parse(body).mutations.map((m: { id: number }) => m.id),
        );
        return ok();
      },
    });
    for (let i = 0; i < 60; i++) p.enqueue("m", { big: "x".repeat(20_000) });
    up = true;
    await p.flush();
    expect(Math.max(...sizes)).toBeLessThan(1_000_000);
    expect(sizes.length).toBeGreaterThan(1);
    expect([...new Set(ids)]).toHaveLength(60);
  });

  it("still sends one edit that is alone over the cap, and stops on the 413", async () => {
    const errors: string[] = [];
    const p = new Pusher("c1", {
      url: "http://x/push",
      fetch: async () => new Response("too big", { status: 413 }),
      onError: (e) => errors.push(e.message),
    });
    p.enqueue("m", { big: "x".repeat(700_000) });
    await p.flush();
    expect(errors[0]).toContain("413");
  });

  it("gives every push request a timeout signal", async () => {
    let signal: AbortSignal | null | undefined;
    const p = new Pusher("c1", {
      url: "http://x/push",
      fetch: async (_, init) => ((signal = init!.signal), ok()),
    });
    p.enqueue("m", {});
    await p.flush();
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
