export interface CourseMethod {
  course: string;
  method: string | null;
}

/**
 * The old single `category` field mixed two axes — what the dish is in a meal, and how it was
 * cooked. This is the mechanical, one-time mapping from every value that field ever held to the
 * new `course` + `method` pair. It is intentionally not "improved" answers for ambiguous dishes
 * (that judgment lives in the categorizer prompt's worked examples) — just what each old id meant.
 */
export const CATEGORY_TO_COURSE_METHOD: Readonly<Record<string, CourseMethod>> = {
  soup: { course: "soup", method: null },
  salad: { course: "salad", method: null },
  dessert: { course: "dessert", method: null },
  bread: { course: "bread", method: null },
  sauce: { course: "sauce", method: null },
  side: { course: "side", method: null },
  "breakfast-dish": { course: "breakfast", method: null },
  pasta: { course: "main", method: null },
  dumplings: { course: "main", method: null },
  bake: { course: "main", method: "bake" },
  stew: { course: "main", method: "stew" },
  grill: { course: "main", method: "grill" },
};

export function mapLegacyCategory(category: string): CourseMethod {
  const mapped = CATEGORY_TO_COURSE_METHOD[category];
  if (!mapped) throw new Error(`unknown legacy category: "${category}"`);
  return mapped;
}

/**
 * Migrates one JSON object in place: a string `category` field becomes `course` + `method` at
 * the same position, every other field untouched. An object with no string `category` field is
 * returned unchanged (`changed: false`) — either already migrated, or not this kind of object.
 *
 * An object that has `category` AND an existing `course` or `method` is refused (throws) rather
 * than silently overwriting a hand-set value — that combination should not occur from the
 * mechanical map alone, so it means something touched the file by hand and needs a human look.
 */
export function migrateCategoryObject(obj: Record<string, unknown>): { value: Record<string, unknown>; changed: boolean; from?: string } {
  if (typeof obj.category !== "string") return { value: obj, changed: false };
  if ("course" in obj || "method" in obj) {
    throw new Error(`refusing to migrate: object already has course/method alongside category "${obj.category}" — resolve by hand`);
  }
  const from = obj.category;
  const { course, method } = mapLegacyCategory(from);
  const value: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "category") {
      value.course = course;
      value.method = method;
    } else {
      value[k] = v;
    }
  }
  return { value, changed: true, from };
}

export interface CategoryChange {
  from: string;
  obj: Record<string, unknown>;
}

/**
 * Migrates a JSON document that is either a single object (a recipe file) or an array of
 * objects (`index.json`, `eval/bench/categorizer.json`). Idempotent: a document with no
 * `category` fields left comes back with zero changes.
 */
export function migrateCategoryDocument(doc: unknown): { value: unknown; changes: CategoryChange[] } {
  if (Array.isArray(doc)) {
    const changes: CategoryChange[] = [];
    const value = doc.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const r = migrateCategoryObject(item as Record<string, unknown>);
        if (r.changed) changes.push({ from: r.from!, obj: r.value });
        return r.value;
      }
      return item;
    });
    return { value, changes };
  }
  if (doc && typeof doc === "object") {
    const r = migrateCategoryObject(doc as Record<string, unknown>);
    return { value: r.value, changes: r.changed ? [{ from: r.from!, obj: r.value }] : [] };
  }
  return { value: doc, changes: [] };
}
