import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const EntrySchema = z.object({ id: z.string(), nameRu: z.string(), nameEn: z.string() });
const IngredientSchema = EntrySchema.extend({ aliases: z.array(z.string()).default([]) });
export type VocabEntry = z.infer<typeof EntrySchema>;
export type IngredientEntry = z.infer<typeof IngredientSchema>;
export interface Vocab { cuisines: VocabEntry[]; categories: VocabEntry[]; ingredients: IngredientEntry[] }

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function loadVocab(dir: string): Promise<Vocab> {
  return {
    cuisines: await readJson(path.join(dir, "cuisines.json"), z.array(EntrySchema)),
    categories: await readJson(path.join(dir, "categories.json"), z.array(EntrySchema)),
    ingredients: await readJson(path.join(dir, "ingredients.json"), z.array(IngredientSchema)),
  };
}
