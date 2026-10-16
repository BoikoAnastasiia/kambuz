import { describe, it, expect } from "vitest";
import { normalize, score, stem } from "../../web/lib/search.js";

const pizza = { names: ["Домашняя пицца", "Homemade pizza"], ingredients: ["мука", "flour", "моцарелла", "mozzarella", "пепперони"] };
const soup = { names: ["Суп с фрикадельками", "Meatball soup"], ingredients: ["фарш", "картофель", "potatoes"] };
const pasta = { names: ["Паста с креветками и чесноком", "Pasta with shrimp and garlic"], ingredients: ["креветка", "shrimp", "чеснок", "garlic"] };

describe("dish search", () => {
  it("ignores case, ё and punctuation", () => {
    expect(normalize("Ёжик, «Пицца»!")).toBe("ежик пицца");
  });

  it("cuts word endings off longer words only", () => {
    expect(stem("пиццу")).toBe("пицц");
    expect(stem("креветки")).toBe("кревет");
    expect(stem("суп")).toBe("суп");
  });

  it("finds a dish by any form of its name, in either language", () => {
    for (const q of ["пицца", "пиццу", "Пиццы", "pizza", "PIZZ"]) expect(score(pizza, q)).toBeGreaterThan(0);
    expect(score(soup, "пицца")).toBe(0);
  });

  it("finds a dish by an ingredient, but ranks a name match higher", () => {
    expect(score(pasta, "креветки")).toBeGreaterThan(score({ ...soup, ingredients: ["креветка"] }, "креветки"));
    expect(score(pizza, "моцарелла")).toBeGreaterThan(0);
  });

  it("needs every word of the query", () => {
    expect(score(pasta, "паста креветки")).toBeGreaterThan(0);
    expect(score(pasta, "паста курица")).toBe(0);
  });

  it("matches word beginnings, so a short word doesn't match inside another", () => {
    expect(score(soup, "суп")).toBeGreaterThan(0);
    expect(score({ names: ["Суперсалат"], ingredients: [] }, "суп")).toBeGreaterThan(0);
    expect(score({ names: ["Борщ"], ingredients: [] }, "орщ")).toBe(0);
  });
});
