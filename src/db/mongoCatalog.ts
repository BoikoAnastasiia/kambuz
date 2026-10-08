import { randomBytes } from "node:crypto";
import { RecipeSchema, type Recipe } from "../schemas/recipe.js";
import type { CatalogStore } from "../orchestrator/catalog.js";
import type { Collections, RecipeDoc } from "./mongo.js";

export function fromDoc(doc: RecipeDoc): Recipe {
  const { _id, archived, archivedAt, ...recipe } = doc;
  return RecipeSchema.parse(recipe);
}

/**
 * The catalog in MongoDB. An archived recipe keeps its document under a new _id, the
 * way the JSON catalog moves the file into archive/, because the orchestrator often
 * writes the replacement under the same recipe id right after archiving the old one.
 */
export class MongoCatalog implements CatalogStore {
  constructor(private c: Collections) {}

  async load(): Promise<Recipe[]> {
    const docs = await this.c.recipes.find({ archived: false }).sort({ _id: 1 }).toArray();
    return docs.map(fromDoc);
  }

  async write(recipe: Recipe): Promise<void> {
    await this.c.recipes.replaceOne({ _id: recipe.id }, { ...recipe, archived: false, archivedAt: null }, { upsert: true });
  }

  async rename(recipe: Recipe, nameRu: string): Promise<void> {
    await this.write({ ...recipe, nameRu });
  }

  async archive(recipe: Recipe): Promise<void> {
    const archivedAt = new Date().toISOString();
    const stamp = archivedAt.replace(/[:.]/g, "-");
    await this.c.recipes.insertOne({ ...recipe, _id: `${recipe.id}--${stamp}-${randomBytes(2).toString("hex")}`, archived: true, archivedAt });
    await this.c.recipes.deleteOne({ _id: recipe.id });
  }
}
