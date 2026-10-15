import "server-only";
import type { Collection } from "mongodb";
import type { RecipeDoc } from "./types";

/**
 * Where an old recipe address lives now. Re-processing a video can give a dish a new id
 * ("pizza-pepperoni--X" → "pizza--X"); the old version stays archived with its id and its place
 * in the video, and the live recipe at that same place is the one a shared link meant.
 */
export async function movedRecipeId(recipes: Collection<RecipeDoc>, id: string): Promise<string | null> {
  const old = await recipes.findOne({ archived: true, id }, { sort: { archivedAt: -1 }, projection: { source: 1 } });
  if (!old) return null;
  const now = await recipes.findOne(
    { archived: false, "source.videoId": old.source.videoId, "source.segmentStart": old.source.segmentStart },
    { projection: { id: 1 } },
  );
  return now?.id ?? null;
}
