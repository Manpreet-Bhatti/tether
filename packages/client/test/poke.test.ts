import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/net.js";
import { connectPoke } from "../src/poke.js";

class FakeWS {
  static all: FakeWS[] = [];
  onopen?: () => void;
  onmessage?: () => void;
  onclose?: () => void;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  close() {}
}
const WS = FakeWS as unknown as typeof WebSocket;
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("connectPoke", () => {
  it("runs one pull at a time and collapses pokes during it into one more", async () => {
    FakeWS.all = [];
    const gates = [defer(), defer(), defer()];
    const pull = vi.fn(() => gates[pull.mock.calls.length - 1]!.promise);
    connectPoke({ url: "ws://x", WebSocket: WS, backoffMs: 1 }, pull);
    const ws = FakeWS.all[0]!;
    ws.onopen!();
    ws.onmessage!();
    ws.onmessage!();
    ws.onmessage!();
    expect(pull).toHaveBeenCalledTimes(1);
    gates[0]!.resolve();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));
    gates[1]!.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it("retries a failed pull and reconnects after close", async () => {
    FakeWS.all = [];
    const pull = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue();
    const stop = connectPoke(
      { url: "ws://x", WebSocket: WS, backoffMs: 1 },
      pull,
    );
    FakeWS.all[0]!.onopen!();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));

    FakeWS.all[0]!.onclose!();
    await vi.waitFor(() => expect(FakeWS.all).toHaveLength(2));
    FakeWS.all[1]!.onopen!();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(3));

    stop();
    FakeWS.all[1]!.onclose!();
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWS.all).toHaveLength(2);
  });

  it("stops for good and reports once when a pull is refused as unauthorized", async () => {
    FakeWS.all = [];
    const onAuthError = vi.fn();
    const pull = vi
      .fn()
      .mockRejectedValue(new HttpError(401, "pull failed: 401"));
    connectPoke(
      { url: "ws://x", WebSocket: WS, backoffMs: 1, onAuthError },
      pull,
    );
    FakeWS.all[0]!.onopen!();
    await vi.waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
    FakeWS.all[0]!.onclose!();
    await new Promise((r) => setTimeout(r, 20));
    expect(pull).toHaveBeenCalledTimes(1);
    expect(FakeWS.all).toHaveLength(1);
  });
});
