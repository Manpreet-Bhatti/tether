import { HttpError, MAX_BACKOFF_MS, nextDelay, sleep } from "./net.js";

export interface PokeOpts {
  url: string;
  WebSocket?: typeof WebSocket;
  backoffMs?: number;
  onAuthError?: (e: Error) => void;
}

// Keeps a socket to the server open and calls `pull` on every poke and every (re)connect.
// At most one pull runs at a time; pokes arriving meanwhile collapse into one more pull after it.
// Returns a function that closes the socket and stops everything.
export function connectPoke(
  opts: PokeOpts,
  pull: () => Promise<unknown>,
): () => void {
  const { backoffMs = 500, WebSocket: WS = WebSocket } = opts;
  let closed = false;
  let ws: WebSocket | undefined;
  let attempt = 0;
  let running = false;
  let queued = false;

  const stop = () => {
    closed = true;
    ws?.close();
  };

  const sync = async () => {
    if (running) return void (queued = true);
    running = true;
    for (let delay = backoffMs; !closed; ) {
      queued = false;
      try {
        await pull();
        delay = backoffMs;
      } catch (e) {
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
          stop();
          opts.onAuthError?.(e);
          break;
        }
        queued = true;
        await sleep(delay);
        delay = nextDelay(delay);
      }
      if (!queued) break;
    }
    running = false;
  };

  const open = () => {
    ws = new WS(opts.url);
    ws.onopen = () => {
      attempt = 0;
      void sync();
    };
    ws.onmessage = () => void sync();
    ws.onclose = async () => {
      if (closed) return;
      await sleep(Math.min(backoffMs * 2 ** attempt++, MAX_BACKOFF_MS));
      if (!closed) open();
    };
  };
  open();

  return stop;
}
