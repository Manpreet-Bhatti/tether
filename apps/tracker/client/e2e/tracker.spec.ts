import { expect, test, type Page } from "@playwright/test";

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
