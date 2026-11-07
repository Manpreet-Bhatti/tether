import { PushResponse, type Mutation } from "@tether/protocol";
import { nextDelay, REQUEST_TIMEOUT_MS, sleep } from "./net.js";

export interface PushOpts {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  schemaVersion?: number;
  backoffMs?: number; // first retry delay, doubles up to 30s
  onError?: (e: Error) => void; // push stopped on a non-retryable response
}

class Fatal extends Error {}

// The server refuses request bodies over 1 MB with 413, which is fatal here, so batches stop well short of it.
const MAX_BATCH_BYTES = 500_000;

// Sends pending mutations in id order, one batch in flight, retrying until the server answers.
// A mutation stays in `pending` after its push is acked, until a pull confirms it.
export class Pusher {
  #pending: Mutation[] = [];
  #sentUpTo = 0;
  #nextId = 1;
  #sending = false;
  #done: Promise<void> = Promise.resolve();

  constructor(
    private clientId: string,
    private opts: PushOpts,
  ) {}

  get pending(): readonly Mutation[] {
    return this.#pending;
  }

  // Drops mutations the server has applied, as reported by a pull.
  confirm(lastMutationId: number): void {
    this.#pending = this.#pending.filter((m) => m.id > lastMutationId);
  }

  #unsent = () => this.#pending.filter((m) => m.id > this.#sentUpTo);

  enqueue(name: string, args: unknown): void {
    this.#pending.push({
      id: this.#nextId++,
      name,
      args,
      timestamp: Date.now(),
    });
    if (this.#sending) return;
    this.#sending = true;
    this.#done = this.#loop();
  }

  // Resolves when everything is sent or push stopped on a non-retryable error.
  flush(): Promise<void> {
    return this.#done;
  }

  async #loop(): Promise<void> {
    try {
      while (this.#unsent().length) await this.#sendBatch();
    } catch (e) {
      this.opts.onError?.(e as Error);
    } finally {
      this.#sending = false;
    }
  }

  async #sendBatch(): Promise<void> {
    const { url, headers, schemaVersion = 1, backoffMs = 500 } = this.opts;
    const send = this.opts.fetch ?? fetch;
    const unsent = this.#unsent().slice(0, 100);
    let size = 0;
    let n = 0;
    for (const m of unsent) {
      size += JSON.stringify(m).length;
      // Always send at least one: a lone edit over the server cap is a real, fatal error.
      if (n && size > MAX_BATCH_BYTES) break;
      n++;
    }
    const mutations = unsent.slice(0, n);
    const body = JSON.stringify({
      clientId: this.clientId,
      schemaVersion,
      mutations,
    });
    for (let delay = backoffMs; ; delay = nextDelay(delay)) {
      try {
        const res = await send(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.ok) {
          PushResponse.parse(await res.json());
          this.#sentUpTo = mutations.at(-1)!.id;
          return;
        }
        if (res.status < 500 && res.status !== 429)
          throw new Fatal(`push failed: ${res.status} ${await res.text()}`);
      } catch (e) {
        if (e instanceof Fatal) throw e;
      }
      await sleep(delay);
    }
  }
}
