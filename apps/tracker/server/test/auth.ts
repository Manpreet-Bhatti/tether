import { sign } from "hono/jwt";

export const secret = "test-secret-test-secret-test-secret!";
export const mint = (sub: string, ttlSec = 60) =>
  sign({ sub, exp: Math.floor(Date.now() / 1000) + ttlSec }, secret, "HS256");
export const bearer = async (sub: string) => ({
  authorization: `Bearer ${await mint(sub)}`,
});
