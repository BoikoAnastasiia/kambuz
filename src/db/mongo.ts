import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";
import type { Recipe } from "../schemas/recipe.js";
import type { VideoStatus } from "../orchestrator/report.js";

/** A recipe as stored: the catalog JSON plus whether it has been replaced by a better version. */
export type RecipeDoc = Recipe & { _id: string; archived: boolean; archivedAt: string | null };

/** One row per YouTube video the pipeline has seen, whatever came of it. */
export interface VideoDoc {
  _id: string; // videoId
  title: string;
  status: VideoStatus;
  recipes: number;
  error: string | null;
  processedAt: string;
}

export type JobStatus = "queued" | "running" | "done" | "error";

/** A request to ingest one URL, written by the site and picked up by the worker. */
export interface JobDoc {
  _id: ObjectId;
  url: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: string[];
  /** Recipe ids this job wrote to the catalog. */
  recipes: string[];
  error: string | null;
  costUsd: number | null;
}

/** The vocabulary files, one document per file, so a deployed site can read them without the repo. */
export interface VocabDoc {
  _id: "ingredients" | "cuisines" | "courses" | "methods";
  items: { id: string; nameRu: string; nameEn: string }[];
}

export interface Collections {
  recipes: Collection<RecipeDoc>;
  videos: Collection<VideoDoc>;
  jobs: Collection<JobDoc>;
  vocab: Collection<VocabDoc>;
}

export function collections(db: Db): Collections {
  return {
    recipes: db.collection<RecipeDoc>("recipes"),
    videos: db.collection<VideoDoc>("videos"),
    jobs: db.collection<JobDoc>("jobs"),
    vocab: db.collection<VocabDoc>("vocab"),
  };
}

export async function ensureIndexes(c: Collections): Promise<void> {
  await c.recipes.createIndex({ archived: 1, mealTypes: 1, course: 1, cuisine: 1 });
  await c.recipes.createIndex({ "ingredients.ingredient": 1 });
  await c.recipes.createIndex({ "source.videoId": 1 });
  await c.jobs.createIndex({ status: 1, createdAt: 1 });
}

/** The database named in the URI's path ("…mongodb.net/kambuz?retryWrites=true"), or "kambuz". */
export function dbNameFrom(uri: string): string {
  const afterHost = uri.replace(/^mongodb(\+srv)?:\/\/[^/]*/, "");
  const name = afterHost.replace(/^\//, "").split("?")[0];
  return name || "kambuz";
}

export async function connectDb(uri: string): Promise<{ client: MongoClient; db: Db; c: Collections }> {
  const client = await MongoClient.connect(uri);
  const db = client.db(dbNameFrom(uri));
  const c = collections(db);
  await ensureIndexes(c);
  return { client, db, c };
}
