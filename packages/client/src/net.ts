export const REQUEST_TIMEOUT_MS = 30_000; // a hung request must fail and retry, not stall its loop
export const MAX_BACKOFF_MS = 30_000;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const nextDelay = (ms: number) => Math.min(ms * 2, MAX_BACKOFF_MS);

// Jittered delay that ends early when the browser comes back online.
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      globalThis.removeEventListener?.("online", done);
      resolve();
    };
    const timer = setTimeout(done, ms * (0.5 + Math.random() / 2));
    globalThis.addEventListener?.("online", done);
  });
