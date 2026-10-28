import { PushResponse, type Mutation } from "@tether/protocol";

export interface PushOpts {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  schemaVersion?: number;
  backoffMs?: number; // first retry delay, doubles up to 30s
  onError?: (e: Error) => void; // push stopped on a non-retryable response
}

class Fatal extends Error {}

// Sends pending mutations in id order, one batch in flight, retrying until the server answers.
export class Pusher {
  #pending: Mutation[] = [];
  #nextId = 1;
  #sending = false;
  #done: Promise<void> = Promise.resolve();

  constructor(
    private clientId: string,
    private opts: PushOpts,
  ) {}

  enqueue(name: string, args: unknown): void {
    this.#pending.push({ id: this.#nextId++, name, args, timestamp: Date.now() });
    if (this.#sending) return;
    this.#sending = true;
    this.#done = this.#loop();
  }

  // Resolves when the queue is empty or push stopped on a non-retryable error.
  flush(): Promise<void> {
    return this.#done;
  }

  async #loop(): Promise<void> {
    try {
      while (this.#pending.length) await this.#sendBatch();
    } catch (e) {
      this.opts.onError?.(e as Error);
    } finally {
      this.#sending = false;
    }
  }

  async #sendBatch(): Promise<void> {
    const { url, headers, schemaVersion = 1, backoffMs = 500 } = this.opts;
    const send = this.opts.fetch ?? fetch;
    const mutations = this.#pending.slice(0, 100);
    const body = JSON.stringify({ clientId: this.clientId, schemaVersion, mutations });
    for (let delay = backoffMs; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        const res = await send(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        });
        if (res.ok) {
          const acked = new Set(PushResponse.parse(await res.json()).results.map((r) => r.id));
          // shortcut: rejected mutations are dropped silently, phase 4 rolls them back via rebase.
          this.#pending = this.#pending.filter((m) => !acked.has(m.id));
          return;
        }
        if (res.status < 500 && res.status !== 429)
          throw new Fatal(`push failed: ${res.status} ${await res.text()}`);
      } catch (e) {
        if (e instanceof Fatal) throw e;
      }
      await new Promise((r) => setTimeout(r, delay * (0.5 + Math.random() / 2)));
    }
  }
}
