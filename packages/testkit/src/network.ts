export type Fault = "ok" | "lose-request" | "lose-response" | "dup";
export type Handler = (url: string, init: RequestInit) => Promise<Response>;

interface Req {
  client: string;
  url: string;
  init: RequestInit;
  // Unset on a ghost: a duplicate the client is no longer waiting on.
  answer?: { resolve: (r: Response) => void; reject: (e: unknown) => void };
}

// Calls queue up until `deliver` picks one, so the test decides delay and order. fast-check's
// seed is the only randomness: replaying a failing seed replays the exact faults.
export class Network {
  #queue: Req[] = [];
  #down = new Set<string>();
  #reliable = false;

  constructor(private handler: Handler) {}

  get pending(): number {
    return this.#queue.length;
  }

  fetchFor(client: string): typeof fetch {
    return ((url: string, init: RequestInit) => {
      if (this.#down.has(client))
        return Promise.reject(new TypeError("network down"));
      if (this.#reliable) return this.handler(String(url), init);
      return new Promise<Response>((resolve, reject) =>
        this.#queue.push({
          client,
          url: String(url),
          init,
          answer: { resolve, reject },
        }),
      );
    }) as typeof fetch;
  }

  // New calls from `client` fail at once; calls already queued stay deliverable.
  setUp(client: string, up: boolean): void {
    up ? this.#down.delete(client) : this.#down.add(client);
  }

  // Picks queued call `index % pending` (no-op when none) and applies `fault` to it.
  async deliver(index: number, fault: Fault = "ok"): Promise<void> {
    if (!this.#queue.length) return;
    const req = this.#queue.splice(index % this.#queue.length, 1)[0]!;
    const { answer } = req;
    if (!answer) return void (await this.handler(req.url, req.init).catch(() => {}));
    if (fault === "lose-request")
      return answer.reject(new TypeError("request lost"));
    let res: Response;
    try {
      res = await this.handler(req.url, req.init);
    } catch (e) {
      return answer.reject(e);
    }
    if (fault === "lose-response")
      answer.reject(new TypeError("response lost"));
    else answer.resolve(res);
    if (fault === "dup") this.#queue.push({ ...req, answer: undefined });
  }

  // Faults off for good: links up, everything queued delivered in order, new calls pass straight through.
  async heal(): Promise<void> {
    this.#reliable = true;
    this.#down.clear();
    while (this.#queue.length) await this.deliver(0);
  }
}
