import { describe, expect, it, vi } from "vitest";
import { pgStorage } from "../src/index.js";

describe("pgStorage.onChange", () => {
  it("retries LISTEN on the next subscribe after a failed first attempt", async () => {
    const listen = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue({});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = pgStorage({ listen } as never);
    s.onChange(() => {});
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    s.onChange(() => {});
    expect(listen).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
