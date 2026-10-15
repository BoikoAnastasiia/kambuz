import { describe, it, expect } from "vitest";
import { amount, duration, localePath, preferredLang, switchPath } from "../../web/lib/i18n.js";

describe("preferredLang", () => {
  it("follows the switch's cookie over the browser", () => {
    expect(preferredLang("ru", "en-US,en;q=0.9")).toBe("ru");
    expect(preferredLang("en", "ru-RU,ru;q=0.9")).toBe("en");
  });
  it("gives Russian to readers of Russian, Ukrainian, Belarusian and Kazakh", () => {
    expect(preferredLang(undefined, "ru-RU,ru;q=0.9,en;q=0.8")).toBe("ru");
    expect(preferredLang(undefined, "uk,en;q=0.5")).toBe("ru");
  });
  it("gives English to everyone else, by the highest q", () => {
    expect(preferredLang(undefined, "en-US,en;q=0.9")).toBe("en");
    expect(preferredLang(undefined, "de-DE")).toBe("en");
    expect(preferredLang(undefined, "en;q=0.4, ru;q=0.8")).toBe("ru");
  });
  it("defaults to Russian without a header or with a junk cookie", () => {
    expect(preferredLang(undefined, null)).toBe("ru");
    expect(preferredLang("fr", null)).toBe("ru");
    expect(preferredLang(undefined, "*")).toBe("ru");
  });
});

describe("paths", () => {
  it("prefixes English only", () => {
    expect(localePath("ru", "/recipe/x")).toBe("/recipe/x");
    expect(localePath("en", "/recipe/x")).toBe("/en/recipe/x");
    expect(localePath("en", "/")).toBe("/en");
  });
  it("switches the same page between languages", () => {
    expect(switchPath("/recipe/x", "en")).toBe("/en/recipe/x");
    expect(switchPath("/en/recipe/x", "ru")).toBe("/recipe/x");
    expect(switchPath("/en", "ru")).toBe("/");
    expect(switchPath("/", "en")).toBe("/en");
  });
});

describe("formatting", () => {
  it("writes durations in each language", () => {
    expect(duration(80, "ru")).toBe("1 ч 20 мин");
    expect(duration(80, "en")).toBe("1 h 20 min");
    expect(duration(0, "en")).toBeNull();
  });
  it("writes amounts with each language's decimal mark and units", () => {
    expect(amount(1.5, "tbsp", "ru")).toBe("1,5 ст. л.");
    expect(amount(1.5, "tbsp", "en")).toBe("1.5 tbsp");
    expect(amount(2, "pc", "en")).toBe("2");
    expect(amount(1, "clove", "en")).toBe("1 clove");
    expect(amount(3, "clove", "en")).toBe("3 cloves");
    expect(amount(null, "g", "en")).toBeNull();
  });
});
