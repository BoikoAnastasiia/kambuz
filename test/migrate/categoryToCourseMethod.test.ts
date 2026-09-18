import { describe, it, expect } from "vitest";
import {
  CATEGORY_TO_COURSE_METHOD,
  mapLegacyCategory,
  migrateCategoryObject,
  migrateCategoryDocument,
} from "../../src/migrate/categoryToCourseMethod.js";

describe("mapLegacyCategory", () => {
  it("maps every legacy category id from the brief's migration table", () => {
    expect(mapLegacyCategory("soup")).toEqual({ course: "soup", method: null });
    expect(mapLegacyCategory("salad")).toEqual({ course: "salad", method: null });
    expect(mapLegacyCategory("dessert")).toEqual({ course: "dessert", method: null });
    expect(mapLegacyCategory("bread")).toEqual({ course: "bread", method: null });
    expect(mapLegacyCategory("sauce")).toEqual({ course: "sauce", method: null });
    expect(mapLegacyCategory("side")).toEqual({ course: "side", method: null });
    expect(mapLegacyCategory("breakfast-dish")).toEqual({ course: "breakfast", method: null });
    expect(mapLegacyCategory("pasta")).toEqual({ course: "main", method: null });
    expect(mapLegacyCategory("dumplings")).toEqual({ course: "main", method: null });
    expect(mapLegacyCategory("bake")).toEqual({ course: "main", method: "bake" });
    expect(mapLegacyCategory("stew")).toEqual({ course: "main", method: "stew" });
    expect(mapLegacyCategory("grill")).toEqual({ course: "main", method: "grill" });
  });

  it("covers exactly the twelve old category ids, no more and no fewer", () => {
    expect(Object.keys(CATEGORY_TO_COURSE_METHOD).sort()).toEqual(
      ["bake", "bread", "breakfast-dish", "dessert", "dumplings", "grill", "pasta", "salad", "sauce", "side", "soup", "stew"],
    );
  });

  it("throws on a category outside the table", () => {
    expect(() => mapLegacyCategory("casserole")).toThrow(/unknown legacy category/);
  });
});

describe("migrateCategoryObject", () => {
  it("replaces category with course + method at the same position, keeping other fields", () => {
    const { value, changed, from } = migrateCategoryObject({ id: "x--v1", nameRu: "X", category: "bake", richness: "hearty" });
    expect(changed).toBe(true);
    expect(from).toBe("bake");
    expect(Object.keys(value)).toEqual(["id", "nameRu", "course", "method", "richness"]);
    expect(value).toEqual({ id: "x--v1", nameRu: "X", course: "main", method: "bake", richness: "hearty" });
  });

  it("is a no-op on an object with no string category field (already migrated)", () => {
    const obj = { id: "x--v1", course: "main", method: "bake" };
    const { value, changed } = migrateCategoryObject(obj);
    expect(changed).toBe(false);
    expect(value).toBe(obj);
  });

  it("throws on an unmapped category value", () => {
    expect(() => migrateCategoryObject({ category: "casserole" })).toThrow(/unknown legacy category/);
  });
});

describe("migrateCategoryDocument", () => {
  it("migrates a single recipe object", () => {
    const { value, changes } = migrateCategoryDocument({ id: "x--v1", category: "soup" });
    expect(value).toEqual({ id: "x--v1", course: "soup", method: null });
    expect(changes).toEqual([{ from: "soup", obj: { id: "x--v1", course: "soup", method: null } }]);
  });

  it("migrates every row of an array document (index.json / bench truth)", () => {
    const { value, changes } = migrateCategoryDocument([
      { id: "a--v1", category: "stew" },
      { videoId: "v1", segmentIndex: 2, category: "salad" },
    ]);
    expect(value).toEqual([
      { id: "a--v1", course: "main", method: "stew" },
      { videoId: "v1", segmentIndex: 2, course: "salad", method: null },
    ]);
    expect(changes).toHaveLength(2);
  });

  it("is idempotent: migrating an already-migrated document changes nothing", () => {
    const once = migrateCategoryDocument([{ id: "a--v1", category: "stew" }]);
    const twice = migrateCategoryDocument(once.value);
    expect(twice.changes).toEqual([]);
    expect(twice.value).toEqual(once.value);
  });
});
