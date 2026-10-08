import { mkdir, readFile, writeFile, readdir, rename as fsRename } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { RecipeSchema, type Recipe } from "../schemas/recipe.js";

/** What the orchestrator needs from wherever recipes are kept. */
export interface CatalogStore {
  load(): Promise<Recipe[]>;
  write(recipe: Recipe): Promise<void>;
  rename(recipe: Recipe, nameRu: string): Promise<void>;
  archive(recipe: Recipe): Promise<void>;
}

/** Keeps every recipe in the primary store and copies each change to the mirror; reads come from the primary. */
export class MirroredCatalog implements CatalogStore {
  constructor(private primary: CatalogStore, private mirror: CatalogStore) {}
  load(): Promise<Recipe[]> {
    return this.primary.load();
  }
  async write(recipe: Recipe): Promise<void> {
    await this.primary.write(recipe);
    await this.mirror.write(recipe);
  }
  async rename(recipe: Recipe, nameRu: string): Promise<void> {
    await this.primary.rename(recipe, nameRu);
    await this.mirror.rename(recipe, nameRu);
  }
  async archive(recipe: Recipe): Promise<void> {
    await this.primary.archive(recipe);
    await this.mirror.archive(recipe);
  }
}

export class Catalog implements CatalogStore {
  constructor(private root: string) {}

  // Serializes write/rename/archive so concurrent callers (e.g. the
  // orchestrator's pLimit pool) can't interleave rebuildIndex() calls and
  // clobber index.json with a stale snapshot.
  private queue: Promise<void> = Promise.resolve();

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private recipesDir = () => path.join(this.root, "recipes");
  private archiveDir = () => path.join(this.root, "archive");
  private file = (id: string) => path.join(this.recipesDir(), `${id}.json`);

  async load(): Promise<Recipe[]> {
    await mkdir(this.recipesDir(), { recursive: true });
    const files = (await readdir(this.recipesDir())).filter((f) => f.endsWith(".json")).sort();
    return Promise.all(files.map(async (f) => RecipeSchema.parse(JSON.parse(await readFile(path.join(this.recipesDir(), f), "utf8")))));
  }

  async write(recipe: Recipe): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.recipesDir(), { recursive: true });
      await writeFile(this.file(recipe.id), JSON.stringify(recipe, null, 2));
      await this.rebuildIndex();
    });
  }

  async rename(recipe: Recipe, nameRu: string): Promise<void> {
    await this.write({ ...recipe, nameRu });
  }

  async archive(recipe: Recipe): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.archiveDir(), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const suffix = randomBytes(2).toString("hex");
      await fsRename(this.file(recipe.id), path.join(this.archiveDir(), `${recipe.id}--${stamp}-${suffix}.json`));
      await this.rebuildIndex();
    });
  }

  private async rebuildIndex(): Promise<void> {
    const all = await this.load();
    const index = all.map((r) => ({
      id: r.id, nameRu: r.nameRu, nameEn: r.nameEn, dishKey: r.dishKey, cuisine: r.cuisine,
      mealTypes: r.mealTypes, course: r.course, method: r.method, completeness: r.completeness, videoId: r.source.videoId,
    }));
    await writeFile(path.join(this.root, "index.json"), JSON.stringify(index, null, 2));
  }
}
