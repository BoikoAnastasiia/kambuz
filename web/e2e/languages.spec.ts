import { expect, test } from "@playwright/test";

// A recipe that has an English translation; any translated recipe would do.
const RECIPE = "/recipe/pizza--MDX8fylSisU";
// Its address before the video was re-processed; the dish is archived under that id.
const OLD_RECIPE = "/recipe/pizza-pepperoni--MDX8fylSisU";

test.describe("a Russian browser", () => {
  test.use({ locale: "ru-RU" });

  test("gets the Russian site at the bare paths", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Что на ужин?");
    await expect(page.getByRole("radio", { name: /Ужин/ })).toBeVisible();
  });

  test("switches the same recipe to English with the flag, and stays English after that", async ({ page }) => {
    await page.goto(RECIPE);
    await expect(page.getByRole("heading", { name: "Ингредиенты" })).toBeVisible();
    await page.getByRole("link", { name: "English" }).click();
    await expect(page).toHaveURL(new RegExp(`/en${RECIPE}$`));
    await expect(page.getByRole("heading", { name: "Ingredients" })).toBeVisible();
    await expect(page).toHaveTitle(/ — Kambuz$/);

    // The choice is kept in a cookie: a bare address now opens the English site.
    await page.goto("/");
    await expect(page).toHaveURL(/\/en$/);

    await page.getByRole("link", { name: "Русский" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Что на ужин?");
    await page.goto(RECIPE);
    await expect(page).toHaveURL(new RegExp(`${RECIPE}$`));
  });
});

test.describe("an English browser", () => {
  test.use({ locale: "en-US" });

  test("is sent to /en, and the picker speaks English", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("What to cook?");
    await page.getByRole("button", { name: /Must-have ingredients/ }).click();
    await expect(page.getByRole("searchbox", { name: "Find an ingredient" })).toBeVisible();
  });

  test("opens a shared Russian recipe link in English, with no Russian in the recipe", async ({ page }) => {
    await page.goto(RECIPE);
    await expect(page).toHaveURL(new RegExp(`/en${RECIPE}$`));
    const recipe = page.locator("article");
    await expect(recipe.getByRole("heading", { level: 1 })).toBeVisible();
    // The source video's title may be Russian; the recipe itself must not be.
    const text = (await recipe.locator("section").allInnerTexts()).join(" ");
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });
});

test("an old recipe address leads to the same dish's current one", async ({ page }) => {
  await page.goto(`/en${OLD_RECIPE}`);
  await expect(page).toHaveURL(new RegExp(`/en${RECIPE}$`));
});

test("the sitemap lists recipes in both languages", async ({ request }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  expect(xml).toContain(`${RECIPE}</loc>`);
  expect(xml).toContain(`/en${RECIPE}"`);
});
