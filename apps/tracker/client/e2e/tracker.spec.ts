import { expect, test, type Browser, type Page } from "@playwright/test";
import { sign } from "hono/jwt";

const titles = (page: Page) =>
  page
    .getByTestId("issue")
    .getByLabel("Title")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

async function add(page: Page, title: string) {
  await page.getByLabel("New issue").fill(title);
  await page.getByRole("button", { name: "Add" }).click();
}

test("create, edit, status, reorder", async ({ page }) => {
  await page.goto("/");
  for (const t of ["one", "two", "three"]) await add(page, t);
  expect(await titles(page)).toEqual(["one", "two", "three"]);

  const row = page.getByTestId("issue").nth(1);
  await row.getByLabel("Title").fill("TWO");
  await row.getByLabel("Title").blur();
  await row.getByLabel("Status").selectOption("done");
  await expect(row.getByLabel("Status")).toHaveValue("done");
  expect(await titles(page)).toEqual(["one", "TWO", "three"]);

  await page
    .getByTestId("issue")
    .nth(2)
    .dragTo(page.getByTestId("issue").nth(0)); // up
  expect(await titles(page)).toEqual(["three", "one", "TWO"]);
  await page
    .getByTestId("issue")
    .nth(0)
    .dragTo(page.getByTestId("issue").nth(2)); // down
  expect(await titles(page)).toEqual(["one", "TWO", "three"]);
});

test("mutation reaches the DOM within 16ms", async ({ page }) => {
  await page.goto("/");
  await add(page, "warm up");
  await page.getByLabel("New issue").fill("timed");

  const ms = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const list = document.querySelector("ul")!;
        const t0 = performance.now();
        new MutationObserver(
          (_, obs) => (obs.disconnect(), resolve(performance.now() - t0)),
        ).observe(list, { childList: true });
        document.querySelector("button")!.click();
      }),
  );
  expect(ms).toBeLessThan(16);
});

const tokenFor = (user: string) =>
  sign(
    { sub: user, exp: Math.floor(Date.now() / 1000) + 300 },
    process.env.JWT_SECRET!,
    "HS256",
  );

const mine = async (p: Page, prefix: string) =>
  (await titles(p)).filter((t) => t.startsWith(prefix));

const synced = async (browser: Browser, user: string) => {
  const token = await tokenFor(user);
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/?user=${user}&token=${token}`);
  return page;
};

test("a change in one window shows up in another within a round trip", async ({
  browser,
}) => {
  const [a, b] = [await synced(browser, "u1"), await synced(browser, "u1")];
  const title = `sync-${Date.now()}`;
  await add(a, title);
  await expect.poll(() => titles(b), { timeout: 1000 }).toContain(title);
});

const pendingInIdb = (page: Page, user: string) =>
  page.evaluate(
    (name) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("pending")) return resolve(0);
          const r = db.transaction("pending").objectStore("pending").count();
          r.onsuccess = () => (db.close(), resolve(r.result));
        };
      }),
    `tether:${user}`,
  );

test("edits made offline survive a reload and reach the server once online", async ({
  browser,
}) => {
  const user = `off-${Date.now()}`;
  const want = [`${user} online edit`, `${user} offline one`, `${user} offline two`];
  const url = `/?user=${user}&token=${await tokenFor(user)}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await add(page, `${user} online edit`);

  await context.setOffline(true);
  await add(page, `${user} offline one`);
  await add(page, `${user} offline two`);
  await expect.poll(() => pendingInIdb(page, user)).toBeGreaterThanOrEqual(2);

  // The page cannot load offline, so block only the API and reload.
  await context.route(/\/(push|pull)$/, (r) => r.abort());
  await context.setOffline(false);
  await page.reload();
  await expect
    .poll(() => mine(page, user))
    .toEqual(want);

  await context.unroute(/\/(push|pull)$/);
  // A fresh context has no IndexedDB, so what it shows came from the server.
  const other = await (await browser.newContext()).newPage();
  await other.goto(url);
  await expect
    .poll(() => mine(other, user), { timeout: 15_000 })
    .toEqual(want);
  await expect.poll(() => pendingInIdb(page, user)).toBe(0);
});

test("tabs stay consistent and another tab takes over when the leader closes", async ({
  browser,
}) => {
  const user = `tabs-${Date.now()}`;
  const url = `/?user=${user}&token=${await tokenFor(user)}`;
  const context = await browser.newContext();
  const [a, b] = [await context.newPage(), await context.newPage()];
  await a.goto(url); // first tab holds the lock
  await b.goto(url);

  await add(b, `${user} from follower`);
  await expect.poll(() => mine(a, user)).toEqual([`${user} from follower`]);
  await add(a, `${user} from leader`);
  await expect.poll(() => mine(b, user)).toEqual([`${user} from follower`, `${user} from leader`]);

  await a.close();
  await add(b, `${user} after takeover`);
  const other = await (await browser.newContext()).newPage();
  await other.goto(url);
  await expect
    .poll(() => mine(other, user), { timeout: 15_000 })
    .toEqual([`${user} from follower`, `${user} from leader`, `${user} after takeover`]);
});
